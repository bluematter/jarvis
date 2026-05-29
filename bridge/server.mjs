#!/usr/bin/env node
// The bridge: browser HUD <-WS-> this server <-Agent SDK-> local Claude Code (in hub/).
// Voice is local + offline: mic PCM -> Whisper -> Claude -> Kokoro -> audio back.
// The browser is pure I/O. All the brains live here + in Claude Code.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
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
  return { fleet, cards: metrics?.cards || [], metricsUpdatedAt: metrics?.updatedAt || null };
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

// --- websocket bridge ---
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  let sessionId = null; // resume across turns => continuous conversation
  let busy = false;
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  const sendAudio = (buf) => ws.readyState === ws.OPEN && ws.send(buf, { binary: true });

  send({ type: "ready", hub: HUB });
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
  });

  async function runTurn(prompt) {
    if (busy) return send({ type: "busy" });
    busy = true;
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
      send({ type: "result", text: finalText });

      // speak it — local Kokoro, streamed per sentence
      if (finalText) {
        send({ type: "speak-start" });
        try { await speak(finalText, sendAudio); } catch (err) { send({ type: "error", text: "TTS: " + (err?.message || err) }); }
        send({ type: "speak-end" });
      }
    } catch (err) {
      send({ type: "error", text: String(err?.message || err) });
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
