#!/usr/bin/env node
// The bridge: browser HUD <-WS-> this server <-Agent SDK-> local Claude Code (in hub/).
// Voice is local + offline: mic PCM -> Whisper -> Claude -> Kokoro -> audio back.
// The browser is pure I/O. All the brains live here + in Claude Code.

import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync, readdirSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { WebSocketServer } from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ROOT } from "./env.mjs"; // loads .env into process.env (must be first)
import { warmVoice, transcribe, synth, setVoice, currentVoice } from "./voice.mjs";
import { loadWakeWord, createDetector } from "./wakeword.mjs";
import { loadSilero, createVAD } from "./silero.mjs";
import { loadTurnDetector, isTurnComplete } from "./turndetect.mjs";
const WAKE_THRESHOLD = Number(process.env.JARVIS_WAKE_THRESHOLD || 0.5); // openWakeWord "hey jarvis" score to fire
// hybrid endpoint: Silero gives accurate silence; the (conservative) turn model only ACCELERATES —
// fire fast when it's confident you've finished a sentence. It never fires early when unsure, so it
// can't cut you off; the Silero silence floor handles everything it isn't sure about.
const CAND_SIL_MS = 250;   // brief pause -> transcribe + ask the turn model "are you done?"
const FLOOR_SIL_MS = 850;  // end after this much silence when the model isn't confident (terse command, etc.)
const NOSPEECH_MS = 6000;  // armed but nothing said -> give up
const CMD_MAX_MS = 15000;  // hard cap on a single command
const PRE_FRAMES = 6;      // ~0.5s rolling stream pre-roll so the first word after "hey jarvis" isn't clipped

const HUD_DIR = join(ROOT, "hud");
const env = process.env;

const PORT = Number(env.PORT || 4317);
const HUB = join(ROOT, env.JARVIS_HUB?.replace(/^\.\//, "") || "hub");
const MODEL = env.JARVIS_MODEL || undefined;
const PERMISSION_MODE = env.JARVIS_PERMISSION_MODE || "bypassPermissions";
// spoken ack when a turn reaches for tools, so a data-gathering turn isn't dead silence
const FILLERS = ["Sure, scanning the data now.", "One sec, pulling that up.", "On it — checking the numbers.", "Let me look that up.", "Give me a moment, digging in."];
const KEEPALIVE = ["Still on it, sir.", "Almost there.", "Bear with me.", "Still digging.", "One more moment."]; // spoken if a tool turn goes quiet too long

// --- static HUD ---
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const readJSON = (p, fb) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fb; } };
const readState = () => {
  const fleet = readJSON(join(HUB, "fleet.json"), null);
  const metrics = readJSON(join(HUB, "metrics", "cards.json"), null);
  const cards = [...(metrics?.cards || [])];
  try { // merge direct-API connector cards (Whop, Telegram, …)
    for (const f of readdirSync(join(HUB, "metrics"))) {
      if (f.endsWith(".card.json")) { const c = readJSON(join(HUB, "metrics", f), null); if (c) cards.push(c); }
    }
  } catch {}
  return { fleet, cards, metricsUpdatedAt: metrics?.updatedAt || null };
};

const httpServer = createServer(async (req, res) => {
  if (req.url.split("?")[0] === "/diff") {
    const id = new URL(req.url, "http://x").searchParams.get("id");
    const order = id && readOrder(id);
    if (!order || !order.branch || !order.base) { res.writeHead(404, { "content-type": "application/json" }).end("{}"); return; }
    try {
      const repoPath = join(ROOT, "..", order.repo);
      const range = `${order.base}..${order.branch}`;
      const stat = (await git(repoPath, ["diff", "--stat", range])).stdout;
      let patch = (await git(repoPath, ["diff", range])).stdout;
      if (patch.length > 14000) patch = patch.slice(0, 14000) + "\n… (truncated — review the branch)";
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ stat, patch, branch: order.branch }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ stat: "", patch: String(e?.message || e), branch: order.branch }));
    }
    return;
  }
  if (req.url.split("?")[0] === "/state") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(readState()));
    return;
  }
  if (req.url.split("?")[0] === "/orders") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(listOrders()));
    return;
  }
  const p = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = join(HUD_DIR, p);
  if (!file.startsWith(HUD_DIR) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});

// --- persistence: survive HUD refresh (resume the session + replay transcript) ---
// Note: long-term/cross-project history already lives in claude-mem's SQLite. This is
// just enough local state to make a browser refresh continuous, no DB needed.
const STATE = join(HUB, "state");
try { mkdirSync(STATE, { recursive: true }); } catch {}
const SESSION_FILE = join(STATE, "session.json");
const TRANSCRIPT_FILE = join(STATE, "transcript.jsonl");
let lastSession = readJSON(SESSION_FILE, {})?.id || null;
const saveSession = (id) => { if (!id) return; lastSession = id; try { writeFileSync(SESSION_FILE, JSON.stringify({ id, updatedAt: new Date().toISOString() })); } catch {} };
const clearSession = () => { lastSession = null; try { writeFileSync(SESSION_FILE, "{}"); } catch {} };
const appendTurn = (role, text) => { if (!text) return; try { appendFileSync(TRANSCRIPT_FILE, JSON.stringify({ t: Date.now(), role, text }) + "\n"); } catch {} };
const recentTurns = (n = 30) => {
  try {
    return readFileSync(TRANSCRIPT_FILE, "utf8").trim().split("\n").filter(Boolean).slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

// morning briefing — auto-runs once per day on first interaction
const todayStr = () => new Date().toISOString().slice(0, 10);
const BRIEF_FILE = join(STATE, "brief.json");
const briefDate = () => readJSON(BRIEF_FILE, {})?.date || "";
const markBriefed = () => { try { writeFileSync(BRIEF_FILE, JSON.stringify({ date: todayStr() })); } catch {} };
const BRIEF_PROMPT = `Give me a short SPOKEN morning briefing. Read metrics/*.card.json for current revenue (Gluely, BasedHealth, Wireflow) and fleet.md's "Active focus" for what changed across projects. In 3-4 natural sentences: lead with the revenue headline and any notable move, then what's actively being worked on, then 1-2 things that need my attention (uncommitted work sitting for days, anything dropping). Conversational, no lists, no markdown — you're speaking to me.`;

// keep the dashboard fresh while the bridge is up: re-scan fleet + re-pull connectors
const REFRESH_MS = Number(process.env.JARVIS_REFRESH_MS || 15 * 60 * 1000);
function refreshData() {
  ensureMemWorker(); // piggyback the keep-alive on the refresh cadence
  for (const script of ["scripts/scan-fleet.mjs", "scripts/run-connectors.mjs"]) {
    try { spawn(process.execPath, [join(ROOT, script)], { cwd: ROOT, stdio: "ignore" }).on("error", () => {}); } catch {}
  }
}

// keep claude-mem's worker alive: its UserPromptSubmit hook fires every turn and waits up to +10s
// (sleep 1 ×10) if the localhost worker is down. Re-spawning it (idempotent) prevents that p99 spike.
function ensureMemWorker() {
  try {
    const base = join(process.env.HOME, ".claude/plugins/cache/thedotmack/claude-mem");
    const vers = readdirSync(base).filter((d) => /^\d/.test(d)).sort().reverse();
    if (!vers.length) return;
    const s = join(base, vers[0], "scripts");
    spawn(process.execPath, [join(s, "bun-runner.js"), join(s, "worker-service.cjs"), "start"], { stdio: "ignore" }).on("error", () => {});
  } catch {}
}

// --- work-orders: Jarvis PROPOSES (writes hub/orders/<id>.json), Michael APPROVES by dispatching
// from the HUD board, the bridge DISPATCHES it into an isolated git worktree on a jarvis/<id> branch.
const ORDERS_DIR = join(HUB, "orders");
try { mkdirSync(ORDERS_DIR, { recursive: true }); } catch {}
const pexec = promisify(execFile);
const git = (cwd, args) => pexec("git", args, { cwd });
const orderPath = (id) => join(ORDERS_DIR, String(id).replace(/[^a-z0-9_-]/gi, "") + ".json");
const readOrder = (id) => readJSON(orderPath(id), null);
const writeOrder = (o) => { try { writeFileSync(orderPath(o.id), JSON.stringify(o, null, 2)); } catch {} };
const listOrders = () => {
  try {
    return readdirSync(ORDERS_DIR).filter((f) => f.endsWith(".json"))
      .map((f) => readJSON(join(ORDERS_DIR, f), null)).filter(Boolean)
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  } catch { return []; }
};

function dispatchPrompt(order, branch) {
  return `You are executing a work-order dispatched by Jarvis.

CRITICAL — ISOLATION: Your current working directory IS your entire sandbox — an isolated git
worktree already checked out on branch "${branch}". Everything you need is here.
- Use RELATIVE paths only. NEVER use an absolute path. NEVER run \`cd\`.
- A separate main checkout of this repo exists elsewhere — you must NOT find it, cd to it, or write
  to it. Stay in your current directory for everything.
- Run git directly (you're already on the right branch): \`git add -A && git commit -m "…"\`.
  Do NOT checkout/switch branches, do NOT push.

WORK-ORDER: ${order.title}

${order.brief}

Do the work idiomatically. When done, commit on this branch, then reply with a 2-3 sentence summary of
exactly what you changed and any follow-up. If the task is unclear or unsafe, make NO changes and say why.`;
}

// hard guard: keep the dispatched agent inside its worktree — no writes outside, no cd / no main checkout
function dispatchPolicy(wt, repoPath) {
  return (name, input) => {
    if (["Write", "Edit", "MultiEdit"].includes(name)) {
      const p = input?.file_path || input?.path || "";
      const abs = p.startsWith("/") ? p : join(wt, p);
      if (!abs.startsWith(wt)) return { behavior: "deny", message: "stay inside your worktree (relative paths only)" };
    }
    if (name === "Bash") {
      const c = String(input?.command || "");
      if (c.includes(repoPath) || /(^|[\s;&|(])cd\s+\//.test(c))
        return { behavior: "deny", message: "work only in your current directory — no cd, no main checkout" };
    }
    return { behavior: "allow", updatedInput: input };
  };
}

async function dispatchOrder(id) {
  const order = readOrder(id);
  if (!order || (order.status !== "proposed" && order.status !== "failed")) return;
  const repoPath = join(ROOT, "..", order.repo);
  if (!existsSync(join(repoPath, ".git"))) { order.status = "failed"; order.summary = "repo not found: " + order.repo; writeOrder(order); return; }
  const branch = "jarvis/" + order.id;
  const wt = join(STATE, "wt", String(order.id).replace(/[^a-z0-9_-]/gi, ""));
  order.status = "in_progress"; order.branch = branch; order.lastActivity = "preparing worktree…"; order.summary = null; writeOrder(order);
  try {
    try { await git(repoPath, ["worktree", "remove", "--force", wt]); } catch {}
    try { await git(repoPath, ["branch", "-D", branch]); } catch {}
    await git(repoPath, ["worktree", "add", "-b", branch, wt, "HEAD"]);
    order.base = (await git(repoPath, ["rev-parse", "HEAD"])).stdout.trim(); // for the diff preview
    writeOrder(order);
    let out = "";
    const stream = query({
      prompt: dispatchPrompt(order, branch),
      options: { cwd: wt, model: MODEL, permissionMode: "default", canUseTool: dispatchPolicy(wt, repoPath), settingSources: ["user", "project"] },
    });
    for await (const ev of stream) {
      if (ev.type === "assistant") {
        for (const b of ev.message?.content || []) if (b.type === "tool_use") {
          order.lastActivity = b.name + (summarizeInput(b.input) ? " · " + summarizeInput(b.input) : ""); writeOrder(order);
        }
      } else if (ev.type === "result") out = ev.result || out;
    }
    order.status = "done"; order.summary = out.trim() || "Done."; order.lastActivity = null; order.worktree = wt; writeOrder(order);
    notify(`Jarvis · ${order.repo}`, `✓ ${order.title} — ready to review on ${order.branch}`);
  } catch (e) {
    order.status = "failed"; order.summary = String(e?.message || e).slice(0, 300); order.lastActivity = null; writeOrder(order);
    notify(`Jarvis · ${order.repo}`, `✕ ${order.title} failed`);
  }
}

// --- websocket bridge ---
const wss = new WebSocketServer({ server: httpServer });

// proactive notifications: a HUD toast (all open tabs) + a native macOS notification
const broadcast = (obj) => { const s = JSON.stringify(obj); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };
function notify(title, body) {
  broadcast({ type: "toast", title, body });
  try { spawn("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], { stdio: "ignore" }).on("error", () => {}); } catch {}
}

// Fuzzy "Hey Jarvis" detector — base.en Whisper mangles "Jarvis" (adjargos, jervis, charvis, javis…).
// Returns { hit, command }; command = the words after the wake token ("" for a bare "Hey Jarvis").
function lev(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function isJarvisTok(t) {
  t = t.toLowerCase().replace(/[^a-z]/g, "").replace(/^ad(?=[jg])/, ""); // "adjargos" -> "jargos"
  if (t.length < 4) return false;
  if (t.startsWith("jarv") || t.startsWith("jerv")) return true;        // jarvis, jarvi, jervis
  return /^[jgch]/.test(t) && t.endsWith("s") && lev(t, "jarvis") <= 2;  // charvis, garvis, jargos
}
function parseWake(text) {
  const toks = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++)
    if (isJarvisTok(toks[i]))
      return { hit: true, command: toks.slice(i + 1).join(" ").replace(/^[\s,.:!?'’-]+/, "").trim() };
  return { hit: false, command: "" };
}
// phrases Whisper hallucinates on silence/noise — never run these as a follow-up command
const NOISE = /^(thank you|thanks( for watching)?|mm-?hmm|uh-?huh|yeah|yes|no|you|bye|okay|ok|so|hmm|hi|hey|the|a|please)[.!?…]*$/i;

wss.on("connection", (ws) => {
  let sessionId = lastSession; // resume the last conversation across HUD refreshes
  let busy = false;
  let lastSttMs = 0; // STT time of the most recent voice utterance, folded into the turn's timing line
  let pendingGate = "none"; // "wake" = the next utterance must contain the wake word to run (hands-free VAD)
  let awaitingCommand = false, awaitingSince = 0; // a bare "Hey Jarvis" arms a short window: the next burst runs as the command, no wake word needed
  const FOLLOWUP_MS = 6000; // window after a bare "Hey Jarvis" to speak the command (the flare cues you to go) — long enough for a camera pause, short enough to mostly avoid catching the next conversational sentence
  // Whisper labels non-speech as "(clicking)", "[BLANK_AUDIO]", "(typing)"… — strip those so a keyboard tap isn't a "command"
  const speechOnly = (s) => (s || "").replace(/[\(\[][^)\]]*[\)\]]/g, " ").replace(/\s+/g, " ").trim();
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  const sendAudio = (buf) => ws.readyState === ws.OPEN && ws.send(buf, { binary: true });
  const detector = createDetector({ threshold: WAKE_THRESHOLD }); // per-connection openWakeWord state
  const vad = createVAD(); // per-connection Silero VAD, used to endpoint a command precisely
  let wakeChain = Promise.resolve(); // serialize async wake/VAD feeds so they don't race their rolling buffers
  // ---- hands-free command capture (bridge owns the audio so it can transcribe + semantically endpoint) ----
  let epActive = false, epSpeech = false, epStart = 0, epSilStart = 0, epArmed = false, epChecking = false, epLastText = "";
  let cmdAudio = [], cmdPre = []; // current command's audio frames + a rolling pre-roll of the stream
  const stripWake = (s) => (s || "").replace(/^\s*(hey\s+)?[a-z']*jarv[a-z']*\b[\s,.:!?'’-]*/i, "").trim();
  const mergeCmd = () => { let L = 0; for (const f of cmdAudio) L += f.length; const o = new Float32Array(L); let k = 0; for (const f of cmdAudio) { o.set(f, k); k += f.length; } return o; };
  function resetCmd() { cmdAudio = []; epSpeech = false; epStart = 0; epSilStart = 0; epArmed = false; epChecking = false; epLastText = ""; }
  function startEndpoint() { epActive = true; resetCmd(); cmdAudio = cmdPre.slice(); epStart = Date.now(); vad.reset(); detector.reset(); } // seed with pre-roll; clear wake buffer so it can't re-fire
  function cancelCapture() { if (!epActive) return; epActive = false; resetCmd(); detector.reset(); send({ type: "idle" }); }
  async function finishCapture(text) { // end of turn: run the command
    if (!epActive) return; epActive = false;
    const snap = mergeCmd(); resetCmd(); detector.reset();
    if (!text) { try { text = stripWake(speechOnly(await transcribe(snap))); } catch { text = ""; } } // reuse the check's transcript if we have one
    send({ type: "endpoint" }); // HUD: drop the listening UI
    if (!text) return send({ type: "idle" });
    console.log(`[wake] RUN "${text}"`);
    send({ type: "transcript", text });
    runTurn(text);
  }
  async function turnCheck() { // brief pause: transcribe what we have, ask the model if the thought is complete
    epChecking = true;
    let text = ""; try { text = stripWake(speechOnly(await transcribe(mergeCmd()))); } catch {}
    if (!epActive) return;
    if (!text) { epChecking = false; return; }            // nothing intelligible yet — keep waiting
    let r = { prob: 1, complete: true }; try { r = await isTurnComplete(text); } catch {}
    if (!epActive) return;
    epLastText = text; // cache so the silence-floor path doesn't transcribe again
    console.log(`[turn] "${text}" ${r.prob.toFixed(4)} -> ${r.complete ? "DONE" : "wait"}`);
    if (r.complete) finishCapture(text); else epChecking = false; // complete -> fire now; else the silence floor decides
  }

  send({ type: "ready", hub: HUB });
  send({ type: "history", items: recentTurns(30) }); // replay so the feed isn't blank on reload
  send({ type: "brief-due", due: briefDate() !== todayStr() }); // first open of the day → auto-briefing
  ensureMemWorker(); // revive the claude-mem worker if it died (avoids the +10s hook stall)
  warmVoice().then(() => send({ type: "voice-ready", voice: currentVoice() })).catch(() => {});

  ws.on("message", async (data, isBinary) => {
    if (isBinary) {
      const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const tag = b.readInt32LE(0); // 1 = continuous wake-word stream · 0 = a captured command/utterance
      if (tag === 1) { // continuous stream @16k Int16: openWakeWord (detect "hey jarvis") + Silero VAD (endpoint)
        const n = (b.length - 4) >> 1, mag = new Float32Array(n), norm = new Float32Array(n);
        for (let i = 0; i < n; i++) { const v = b.readInt16LE(4 + i * 2); mag[i] = v; norm[i] = v / 32768; }
        wakeChain = wakeChain.then(async () => {
          cmdPre.push(norm); if (cmdPre.length > PRE_FRAMES) cmdPre.shift(); // rolling pre-roll of the stream
          if (!epActive && !busy && await detector.feed(mag, Date.now())) {
            console.log(`[wake] FIRE ${detector.score().toFixed(2)}`); send({ type: "wake-fire" }); startEndpoint();
          }
          if (epActive) {
            cmdAudio.push(norm);
            const p = await vad.feed(norm), now = Date.now();
            if (p > 0.5) { epSpeech = true; epArmed = true; epSilStart = 0; epLastText = ""; } // speaking
            else if (epSpeech) {
              if (!epSilStart) epSilStart = now;
              const sil = now - epSilStart;
              if (sil >= FLOOR_SIL_MS) finishCapture(epLastText);                      // silence floor — reuse the check's transcript if any
              else if (sil >= CAND_SIL_MS && epArmed && !epChecking) { epArmed = false; turnCheck(); } // brief pause -> ask the model (fires early if confident)
            }
            if (!epSpeech && now - epStart >= NOSPEECH_MS) cancelCapture();             // nothing said -> give up
            else if (now - epStart >= CMD_MAX_MS) finishCapture();                      // safety cap
          }
        }).catch(() => {});
        return;
      }
      // tag 0: a command captured AFTER the wake fired (or push-to-talk) — Float32 [-1,1] @16k -> run directly
      if (busy) return send({ type: "busy" });
      send({ type: "transcribing" });
      const n = (b.length - 4) >> 2, audio = new Float32Array(n);
      for (let i = 0; i < n; i++) audio[i] = b.readFloatLE(4 + i * 4);
      let text = "";
      const stStt = Date.now();
      try { text = await transcribe(audio); }
      catch (err) { return send({ type: "error", text: "STT: " + (err?.message || err) }); }
      lastSttMs = Date.now() - stStt;
      const clean = speechOnly(text);
      send({ type: "transcript", text: clean });
      if (!clean) return send({ type: "idle" });
      console.log(`[wake] RUN "${clean}"`);
      return runTurn(clean);
    }
    // text frame = JSON control
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "voice" && msg.name) { if (setVoice(msg.name)) console.log(`[voice] -> ${msg.name}`); return; }
    if (msg.type === "converse") { startEndpoint(); return; } // Jarvis finished speaking → endpoint the follow-up reply
    if (msg.type === "clientlog") { console.log(`[client] ${msg.msg}`); return; } // temporary: surface HUD playback events in the log

    if (msg.type === "prompt" && msg.text?.trim()) return runTurn(msg.text);
    if (msg.type === "search" && msg.text?.trim()) return runSearch(msg.text);
    if (msg.type === "brief") return runBrief();
    if (msg.type === "dispatch" && msg.id) { dispatchOrder(msg.id); return; } // fire-and-forget; HUD polls /orders
  });

  // read-only history search over claude-mem (separate from the conversation; no TTS, no writes)
  let searching = false;
  async function runSearch(q) {
    if (searching) return;
    searching = true;
    send({ type: "search-start", q });
    let out = "";
    try {
      const stream = query({
        prompt: `Search Michael's work history using the claude-mem tools (try smart_search first, then timeline if useful). Query: "${q}". Return the most relevant hits as a tight list — each line: what it was · which project · roughly when. No preamble, no markdown headers. If nothing matches, say so plainly.`,
        options: {
          cwd: HUB,
          model: MODEL,
          permissionMode: "default",
          canUseTool: searchPolicy,
          settingSources: ["user", "project"],
          includePartialMessages: true,
        },
      });
      for await (const ev of stream) {
        if (ev.type === "stream_event") {
          const d = ev.event?.delta;
          if (d?.type === "text_delta" && d.text) { out += d.text; send({ type: "search-delta", text: d.text }); }
        } else if (ev.type === "result") out = ev.result || out;
      }
      send({ type: "search-result", text: out.trim() });
    } catch (err) {
      send({ type: "search-error", text: String(err?.message || err) });
    } finally {
      searching = false;
    }
  }

  // --- persistent conversation session: ONE streaming-input query() per connection keeps the CLI +
  // MCP servers WARM across turns (no per-turn re-init). Each pushed user message is one turn. ---
  function makeInput() {
    const queue = []; let waiting = null; let closed = false;
    return {
      iterable: { [Symbol.asyncIterator]() { return { next() {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => { waiting = res; });
      } }; } },
      push(text) {
        const msg = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
        if (waiting) { const w = waiting; waiting = null; w({ value: msg, done: false }); } else queue.push(msg);
      },
      close() { closed = true; if (waiting) { const w = waiting; waiting = null; w({ value: undefined, done: true }); } },
    };
  }

  let convo = null;       // { input, q, alive } — the live session
  let currentTurn = null; // accumulators for the in-flight turn

  function startConvo() {
    const input = makeInput();
    const q = query({
      prompt: input.iterable,
      options: {
        cwd: HUB, model: MODEL, permissionMode: PERMISSION_MODE, effort: "low", // effort low = lower cost, ~0 latency
        settingSources: ["user", "project"], includePartialMessages: true,
        ...(sessionId ? { resume: sessionId } : {}),
      },
    });
    convo = { input, q, alive: true };
    (async () => {
      try { for await (const ev of q) routeEvent(ev); }
      catch (err) {
        const m = String(err?.message || err);
        if (sessionId && /session|resume|not\s*found|no such/i.test(m)) { clearSession(); sessionId = null; } // drop stale resume
        if (currentTurn && !currentTurn.done) { send({ type: "error", text: m }); finalizeTurn(currentTurn); }
      } finally { if (convo) convo.alive = false; if (currentTurn && !currentTurn.done) finalizeTurn(currentTurn); }
    })();
  }

  function routeEvent(ev) {
    if (ev.session_id) sessionId = ev.session_id;
    const T = currentTurn;
    if (!T) return;
    if (ev.type === "stream_event") {
      const d = ev.event?.delta;
      if (d?.type === "text_delta" && d.text) {
        if (!T.tFirstDelta) T.tFirstDelta = Date.now() - T.t0; // time-to-first-token = "thinking"
        send({ type: "delta", text: d.text }); T.pending += d.text; pullTTS(T, false);
      }
    } else if (ev.type === "assistant") {
      for (const b of ev.message?.content || []) if (b.type === "tool_use") {
        T.tools++;
        if (T.tools === 1 && !T.startedSpeaking) enqueueTTS(T, FILLERS[(Math.random() * FILLERS.length) | 0]); // fill the gather-silence
        send({ type: "tool", name: b.name, input: summarizeInput(b.input) });
      }
    } else if (ev.type === "result") {
      T.tResult = Date.now() - T.t0; T.finalText = ev.result || T.finalText; finalizeTurn(T);
    }
  }

  function enqueueTTS(T, s) { // sequential synth: preserves order, pipelines with generation
    const t = s.trim(); if (!t) return; T.queued++; T.tLastChunk = Date.now(); // reset the keep-alive silence timer
    T.ttsChain = T.ttsChain
      .then(() => { const st = Date.now(); return synth(t).then((b) => { T.synthMs.push(Date.now() - st); return b; }); })
      .then((b) => {
        if (!b) return;
        if (!T.startedSpeaking) { T.startedSpeaking = true; T.tFirstAudio = Date.now() - T.t0; send({ type: "speak-start" }); }
        T.chunkAt.push(Date.now() - T.t0);
        sendAudio(b);
      }).catch(() => {});
  }
  function pullTTS(T, final) { // pull speakable chunks out of T.pending as the answer streams
    // FIRST chunk only: start talking ASAP. Waiting for a whole sentence costs seconds (the period
    // arrives late AND a long chunk is slow to synthesize), which is dead air. Instead break on the
    // earliest clause boundary (, ; : . ! ?), or a word boundary once the opening line runs long — a
    // shorter first chunk synthesizes faster too. Everything after uses normal full-sentence boundaries.
    if (T.queued === 0 && !final) {
      const m = /^([\s\S]{14,}?[.!?,;:])\s/.exec(T.pending) || /^([\s\S]{48,}?\S)\s/.exec(T.pending);
      if (m) { enqueueTTS(T, m[1]); T.pending = T.pending.slice(m[0].length); }
    }
    let m;
    while ((m = /^([\s\S]*?[.!?]+)\s+/.exec(T.pending))) { enqueueTTS(T, m[1]); T.pending = T.pending.slice(m[0].length); }
    if (final && T.pending.trim()) { enqueueTTS(T, T.pending); T.pending = ""; }
  }
  async function finalizeTurn(T) {
    if (T.done) return; T.done = true; clearInterval(T.keepAlive);
    T.finalText = (T.finalText || "").trim();
    if (!T.queued && !T.pending && T.finalText) T.pending = T.finalText; // no deltas → speak the result
    pullTTS(T, true);
    appendTurn("jarvis", T.finalText);
    saveSession(sessionId);
    send({ type: "result", text: T.finalText });
    await T.ttsChain; // every sentence synthesized + sent, in order
    send(T.startedSpeaking ? { type: "speak-end" } : { type: "idle" });
    timingLog(T);
    busy = false;
    if (currentTurn === T) currentTurn = null;
    if (T.resolve) T.resolve();
  }

  async function speakTurn(youLabel, prompt) {
    if (busy) return send({ type: "busy" });
    busy = true;
    appendTurn("you", youLabel);
    send({ type: "thinking" });
    let cold = false;
    if (!convo || !convo.alive) { startConvo(); cold = true; } // (re)spawn the warm session on first turn / after death
    const T = {
      pending: "", ttsChain: Promise.resolve(), startedSpeaking: false, queued: 0, finalText: "", done: false, resolve: null,
      cold, stt: lastSttMs, t0: 0, tFirstDelta: 0, tFirstAudio: 0, tResult: 0, tools: 0, synthMs: [], chunkAt: [], label: youLabel,
      tLastChunk: 0, keepAlive: null,
    };
    lastSttMs = 0;
    currentTurn = T;
    // keep the voice alive on long tool turns: if we've spoken a filler but then gone quiet (still working,
    // answer not yet streaming), say a brief reassurance instead of leaving dead air.
    T.keepAlive = setInterval(() => {
      if (T.done) { clearInterval(T.keepAlive); return; }
      if (T.startedSpeaking && !T.tFirstDelta && Date.now() - (T.tLastChunk || T.t0) > 5000)
        enqueueTTS(T, KEEPALIVE[(Math.random() * KEEPALIVE.length) | 0]);
    }, 2000);
    const wait = new Promise((res) => { T.resolve = res; });
    T.t0 = Date.now(); // submit moment — all timings are relative to this
    try { convo.input.push(prompt); }
    catch (err) { send({ type: "error", text: String(err?.message || err) }); busy = false; currentTurn = null; return; }
    await wait;
  }

  const runTurn = (prompt) => speakTurn(prompt, prompt);
  const runBrief = () => { markBriefed(); return speakTurn("☼ Morning briefing", BRIEF_PROMPT); };

  ws.on("close", () => { try { convo?.q?.close?.(); } catch {} convo = null; currentTurn = null; });
});

function bufToFloat32(buf) {
  const n = Math.floor(buf.byteLength / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

// history search may only read claude-mem (+ basic read tools) — never write or run shell
function searchPolicy(name, input) {
  if (name.includes("claude-mem") || ["Read", "Glob", "Grep"].includes(name)) return { behavior: "allow", updatedInput: input };
  return { behavior: "deny", message: "history search is read-only (claude-mem only)" };
}

function summarizeInput(input) {
  if (!input) return "";
  if (typeof input === "string") return input.slice(0, 80);
  const s = input.command || input.query || input.prompt || input.path || input.file_path || "";
  return String(s).slice(0, 80);
}

// one tidy timing line per turn → ~/Library/Logs/jarvis-bridge.log
//   watch live:  tail -f ~/Library/Logs/jarvis-bridge.log | grep '\[turn\]'
// stt=STT ms · think=time-to-first-word (LLM) · 1st-audio=when Jarvis starts talking ·
// gen=full answer generated · tts=[per-sentence synth ms] · cadence=[audio-chunk send times] · all ms from submit
function timingLog(T) {
  const r = (n) => Math.round(n || 0);
  const parts = [
    `[turn] ${T.cold ? "cold" : "warm"}`,
    `stt=${T.stt ? r(T.stt) : "-"}`,
    `think=${r(T.tFirstDelta)}`,
    `1st-audio=${r(T.tFirstAudio)}`,
    `gen=${r(T.tResult)}`,
    `tts=${T.synthMs.length}[${T.synthMs.map(r).join("/")}]`,
    `total=${r(Date.now() - T.t0)}`,
    `tools=${T.tools}`,
  ];
  if (T.chunkAt.length > 1) parts.push(`cadence=[${T.chunkAt.map(r).join(",")}]`);
  console.log(parts.join("  "));
}

httpServer.listen(PORT, () => {
  console.log(`\n  JARVIS online`);
  console.log(`  HUD:  http://localhost:${PORT}`);
  console.log(`  hub:  ${HUB}`);
  console.log(`  mode: ${PERMISSION_MODE} · model: ${MODEL || "(default)"}`);
  refreshData(); // freshen fleet + connectors now…
  setInterval(refreshData, REFRESH_MS); // …and every ~15 min so the TV never goes stale
  console.log(`  auto-refresh: every ${Math.round(REFRESH_MS / 60000)} min`);
  warmVoice({
    sttModel: env.JARVIS_STT_MODEL,
    ttsModel: env.JARVIS_TTS_MODEL,
    dtype: env.JARVIS_TTS_DTYPE,
    voice: env.JARVIS_VOICE,
    speed: env.JARVIS_TTS_SPEED ? Number(env.JARVIS_TTS_SPEED) : undefined,
    log: (m) => console.log("  " + m),
  }).catch((e) => console.log("  voice FAILED: " + (e?.message || e)));
  loadWakeWord((m) => console.log("  " + m)).catch((e) => console.log("  wake FAILED: " + (e?.message || e)));
  loadSilero((m) => console.log("  " + m)).catch((e) => console.log("  vad FAILED: " + (e?.message || e)));
  loadTurnDetector((m) => console.log("  " + m)).catch((e) => console.log("  turn FAILED: " + (e?.message || e)));
});
