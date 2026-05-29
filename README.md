# JARVIS

An Iron Man–style HUD that talks to your **local Claude Code** and is aware of your **entire fleet of projects** — not one repo in isolation. Put it on a TV, clap to wake it, talk to it.

```
 TV / browser (HUD)            local bridge               Claude Code
 ┌────────────────┐   WS    ┌──────────────────┐  Agent  ┌──────────────┐
 │ reactive orb   │◄──────►│ server.mjs        │  SDK    │ runs in hub/ │
 │ clap + mic     │ audio  │ + WebSocket       │◄───────►│ + all MCPs   │
 │ STT/TTS        │ +text  │ + session resume  │ spawns  │ + fleet.md   │
 └────────────────┘        └──────────────────┘         └──────────────┘
```

The browser is pure I/O. All the brains live in the bridge + Claude Code. Nothing is exposed beyond localhost.

## Quick start

```bash
cp .env.example .env        # edit if needed
pnpm install
pnpm scan                   # builds hub/fleet.md from all your projects
pnpm jarvis                 # starts the bridge + HUD
```

Open **http://localhost:4317** (Chrome recommended for voice). Hold **Space** or the mic button to talk, or **double-clap** to wake. Jarvis speaks its replies.

`pnpm dev` does scan + start in one go.

## How it works

- **`hub/`** is the brain. `hub/CLAUDE.md` is the Jarvis persona; `hub/fleet.md` (generated) is the live status of every project; `hub/metrics/` caches business data. Claude Code runs *from this directory*, so it sees all of it.
- **`scripts/scan-fleet.mjs`** walks `PROJECTS_ROOT`, reads each project's CLAUDE.md + git state, and writes `fleet.md`. Re-run it (or schedule it) to keep Jarvis current.
- **`bridge/server.mjs`** drives Claude Code via the Agent SDK with `settingSources: ["user","project"]`, so it loads `hub/CLAUDE.md` **and your existing MCP servers** (PostHog, RevenueCat, GSC, Gmail…). Sessions resume across turns, so it's a continuous conversation.
- **`hud/index.html`** is the interface: a 3-column dashboard — **left:** live cards (Fleet + Revenue + Search + Product, polled from `/state`); **center:** the reactive orb, double-clap wake, push-to-talk; **right:** live tool-activity feed. The Fleet card populates immediately from `pnpm scan`; the rest fill in after `pnpm metrics`.

## Voice: fully local & offline

STT and TTS both run **on your machine as ONNX in Node — no Python, no cloud, no API keys**:

- **STT:** Whisper (`whisper-base.en`) via `@huggingface/transformers`. The browser captures raw mic PCM, downsamples to 16 kHz, and ships it to the bridge.
- **TTS:** Kokoro-82M via `kokoro-js`, streamed back **per sentence** so Jarvis starts talking before the whole reply is synthesized. Default voice `bm_george` (British male).

Models download once on first run (~150 MB total) to the HF cache, then run locally. Configure model/voice/quality in `.env`. **Barge-in** is on — clap or hold Space while Jarvis is talking and he stops to listen.

## Business data (RevenueCat · GSC · PostHog)

Jarvis pulls revenue and search data through MCP servers and **caches summaries to `hub/metrics/`** so it answers instantly. The servers are registered in your user scope (so every project can use them too); the bridge picks them up automatically.

```bash
pnpm metrics    # pulls all sources -> hub/metrics/*.md  (run nightly via /schedule)
```

To finish connecting (one-time):

- **RevenueCat** — set `REVENUECAT_V2_API_KEY` in `.env` (a v2 *secret* key from RevenueCat → Project settings → API keys).
- **Google Search Console** — drop an OAuth client-secrets JSON (Desktop app, from Google Cloud Console) at `~/.config/jarvis/gsc_client_secret.json`; first `pnpm metrics` opens a browser to authorize.
- **PostHog** — already connected.

Re-register or inspect anytime with `claude mcp list`. `hub/metrics/` is gitignored — business data never leaves your machine.

## Roadmap

- [x] Local Whisper STT + Kokoro TTS (offline)
- [x] Barge-in (interrupt while speaking)
- [x] RevenueCat + GSC + PostHog via MCP, cached to `hub/metrics/`
- [x] HUD dashboard cards (Fleet + Revenue + Search + Product), polled live
- [ ] `fleet.md` + metrics nightly auto-refresh (`/schedule`)
- [ ] Per-project deep-context files in `hub/projects/`
- [ ] AudioWorklet capture (replace deprecated ScriptProcessor)
