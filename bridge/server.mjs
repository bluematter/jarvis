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
import { warmVoice, transcribe, synth } from "./voice.mjs";

const HUD_DIR = join(ROOT, "hud");
const env = process.env;

const PORT = Number(env.PORT || 4317);
const HUB = join(ROOT, env.JARVIS_HUB?.replace(/^\.\//, "") || "hub");
const MODEL = env.JARVIS_MODEL || undefined;
const PERMISSION_MODE = env.JARVIS_PERMISSION_MODE || "bypassPermissions";

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
  for (const script of ["scripts/scan-fleet.mjs", "scripts/run-connectors.mjs"]) {
    try { spawn(process.execPath, [join(ROOT, script)], { cwd: ROOT, stdio: "ignore" }).on("error", () => {}); } catch {}
  }
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

wss.on("connection", (ws) => {
  let sessionId = lastSession; // resume the last conversation across HUD refreshes
  let busy = false;
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  const sendAudio = (buf) => ws.readyState === ws.OPEN && ws.send(buf, { binary: true });

  send({ type: "ready", hub: HUB });
  send({ type: "history", items: recentTurns(30) }); // replay so the feed isn't blank on reload
  send({ type: "brief-due", due: briefDate() !== todayStr() }); // first open of the day → auto-briefing
  warmVoice().then(() => send({ type: "voice-ready" })).catch(() => {});

  ws.on("message", async (data, isBinary) => {
    // binary frame = recorded utterance (Float32 PCM @16k) -> transcribe -> run
    if (isBinary) {
      if (busy) return send({ type: "busy" });
      send({ type: "transcribing" });
      let text = "";
      try {
        text = await transcribe(bufToFloat32(data));
      } catch (err) {
        return send({ type: "error", text: "STT: " + (err?.message || err) });
      }
      send({ type: "transcript", text });
      if (!text) return send({ type: "idle" });
      return runTurn(text);
    }
    // text frame = JSON control (typed prompt)
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
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

  // a spoken turn: streams the answer AND synthesizes each sentence the moment it's ready, so the
  // first audio goes out while the rest of the reply is still being generated (much lower latency).
  async function speakTurn(youLabel, prompt) {
    if (busy) return send({ type: "busy" });
    busy = true;
    appendTurn("you", youLabel);
    send({ type: "thinking" });
    let finalText = "", pending = "", startedSpeaking = false, queued = 0;
    let ttsChain = Promise.resolve();
    const enqueueTTS = (s) => { // sequential: preserves sentence order, pipelines with generation
      const t = s.trim(); if (!t) return; queued++;
      ttsChain = ttsChain.then(() => synth(t)).then((b) => {
        if (!b) return;
        if (!startedSpeaking) { startedSpeaking = true; send({ type: "speak-start" }); }
        sendAudio(b);
      }).catch(() => {});
    };
    const pull = (final) => { // pull complete sentences (terminator + following space) out of `pending`
      let m;
      while ((m = /^([\s\S]*?[.!?]+)\s+/.exec(pending))) { enqueueTTS(m[1]); pending = pending.slice(m[0].length); }
      if (final && pending.trim()) { enqueueTTS(pending); pending = ""; }
    };
    try {
      const stream = query({
        prompt,
        options: {
          cwd: HUB, model: MODEL, permissionMode: PERMISSION_MODE,
          settingSources: ["user", "project"], includePartialMessages: true,
          ...(sessionId ? { resume: sessionId } : {}),
        },
      });
      for await (const ev of stream) {
        if (ev.session_id) sessionId = ev.session_id;
        if (ev.type === "stream_event") {
          const d = ev.event?.delta;
          if (d?.type === "text_delta" && d.text) { send({ type: "delta", text: d.text }); pending += d.text; pull(false); }
        } else if (ev.type === "assistant") {
          for (const b of ev.message?.content || []) if (b.type === "tool_use") send({ type: "tool", name: b.name, input: summarizeInput(b.input) });
        } else if (ev.type === "result") finalText = ev.result || finalText;
      }
      finalText = (finalText || "").trim();
      if (!queued && !pending && finalText) pending = finalText; // no deltas streamed → speak the result
      pull(true);
      appendTurn("jarvis", finalText);
      saveSession(sessionId);
      send({ type: "result", text: finalText });
      await ttsChain; // wait for every sentence to be synthesized + sent, in order
      send(startedSpeaking ? { type: "speak-end" } : { type: "idle" });
    } catch (err) {
      const m = String(err?.message || err);
      if (sessionId && /session|resume|not\s*found|no such/i.test(m)) { clearSession(); sessionId = null; } // stale resume
      send({ type: "error", text: m });
      try { await ttsChain; } catch {}
      if (startedSpeaking) send({ type: "speak-end" });
    } finally {
      busy = false;
    }
  }

  const runTurn = (prompt) => speakTurn(prompt, prompt);
  const runBrief = () => { markBriefed(); return speakTurn("☼ Morning briefing", BRIEF_PROMPT); };
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
});
