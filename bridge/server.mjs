#!/usr/bin/env node
// The bridge: browser HUD <-WS-> this server <-Agent SDK-> local Claude Code (in hub/).
// The browser is pure I/O. All the brains live here + in Claude Code.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// --- env (tiny .env loader, no dep) ---
const env = { ...process.env };
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const PORT = Number(env.PORT || 4317);
const HUB = join(ROOT, env.JARVIS_HUB?.replace(/^\.\//, "") || "hub");
const MODEL = env.JARVIS_MODEL || undefined;
const PERMISSION_MODE = env.JARVIS_PERMISSION_MODE || "bypassPermissions";

// --- static HUD ---
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const httpServer = createServer((req, res) => {
  let p = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = join(__dirname, "..", "hud", p);
  if (!file.startsWith(join(__dirname, "..", "hud")) || !existsSync(file)) {
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

  send({ type: "ready", hub: HUB });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== "prompt" || !msg.text?.trim()) return;
    if (busy) { send({ type: "busy" }); return; }
    busy = true;

    send({ type: "thinking" });
    let finalText = "";

    try {
      const stream = query({
        prompt: msg.text,
        options: {
          cwd: HUB,
          model: MODEL,
          permissionMode: PERMISSION_MODE,
          // Load CLAUDE.md + the user's MCP servers (PostHog, RevenueCat, GSC, Gmail...).
          settingSources: ["user", "project"],
          includePartialMessages: true,
          ...(sessionId ? { resume: sessionId } : {}),
        },
      });

      for await (const ev of stream) {
        if (ev.session_id) sessionId = ev.session_id;

        // streaming text deltas -> live "typing" + drives the orb
        if (ev.type === "stream_event") {
          const d = ev.event?.delta;
          if (d?.type === "text_delta" && d.text) send({ type: "delta", text: d.text });
          continue;
        }

        // tool calls -> the "checking PostHog... reading eatiq-mobile..." feed
        if (ev.type === "assistant") {
          for (const block of ev.message?.content || []) {
            if (block.type === "tool_use") {
              send({ type: "tool", name: block.name, input: summarizeInput(block.input) });
            }
          }
          continue;
        }

        // final answer -> spoken aloud
        if (ev.type === "result") {
          finalText = ev.result || finalText;
        }
      }

      send({ type: "result", text: finalText.trim() });
    } catch (err) {
      send({ type: "error", text: String(err?.message || err) });
    } finally {
      busy = false;
    }
  });
});

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
  console.log(`  mode: ${PERMISSION_MODE}\n`);
});
