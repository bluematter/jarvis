#!/usr/bin/env node
// The bridge: browser HUD <-WS-> this server <-Agent SDK-> local Claude Code (in hub/).
// Voice is local + offline: mic PCM -> Whisper -> Claude -> Kokoro -> audio back.
// The browser is pure I/O. All the brains live here + in Claude Code.

import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { WebSocketServer } from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ROOT } from "./env.mjs"; // loads .env into process.env (must be first)
import { warmVoice, transcribe, speak } from "./voice.mjs";

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

const httpServer = createServer((req, res) => {
  if (req.url.split("?")[0] === "/state") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(readState()));
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

// --- websocket bridge ---
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  let sessionId = lastSession; // resume the last conversation across HUD refreshes
  let busy = false;
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  const sendAudio = (buf) => ws.readyState === ws.OPEN && ws.send(buf, { binary: true });

  send({ type: "ready", hub: HUB });
  send({ type: "history", items: recentTurns(30) }); // replay so the feed isn't blank on reload
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

  async function runTurn(prompt) {
    if (busy) return send({ type: "busy" });
    busy = true;
    appendTurn("you", prompt);
    send({ type: "thinking" });
    let finalText = "";

    try {
      const stream = query({
        prompt,
        options: {
          cwd: HUB,
          model: MODEL,
          permissionMode: PERMISSION_MODE,
          settingSources: ["user", "project"], // loads hub CLAUDE.md + your MCP servers
          includePartialMessages: true,
          ...(sessionId ? { resume: sessionId } : {}),
        },
      });

      for await (const ev of stream) {
        if (ev.session_id) sessionId = ev.session_id;
        if (ev.type === "stream_event") {
          const d = ev.event?.delta;
          if (d?.type === "text_delta" && d.text) send({ type: "delta", text: d.text });
        } else if (ev.type === "assistant") {
          for (const block of ev.message?.content || []) {
            if (block.type === "tool_use") send({ type: "tool", name: block.name, input: summarizeInput(block.input) });
          }
        } else if (ev.type === "result") {
          finalText = ev.result || finalText;
        }
      }
      finalText = finalText.trim();
      appendTurn("jarvis", finalText);
      saveSession(sessionId);
      send({ type: "result", text: finalText });

      // speak it — local Kokoro, streamed per sentence
      if (finalText) {
        send({ type: "speak-start" });
        try { await speak(finalText, sendAudio); } catch (err) { send({ type: "error", text: "TTS: " + (err?.message || err) }); }
        send({ type: "speak-end" });
      }
    } catch (err) {
      const m = String(err?.message || err);
      // a stale/invalid resumed session: drop it so the next turn starts clean
      if (sessionId && /session|resume|not\s*found|no such/i.test(m)) { clearSession(); sessionId = null; }
      send({ type: "error", text: m });
    } finally {
      busy = false;
    }
  }
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
  console.log(`  mode: ${PERMISSION_MODE}`);
  warmVoice({
    sttModel: env.JARVIS_STT_MODEL,
    ttsModel: env.JARVIS_TTS_MODEL,
    dtype: env.JARVIS_TTS_DTYPE,
    voice: env.JARVIS_VOICE,
    log: (m) => console.log("  " + m),
  }).catch((e) => console.log("  voice FAILED: " + (e?.message || e)));
});
