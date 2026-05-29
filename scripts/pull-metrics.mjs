#!/usr/bin/env node
// Pulls business data via the MCP servers (RevenueCat, GSC, PostHog) and caches
// concise markdown summaries into hub/metrics/ so Jarvis answers instantly from
// cache instead of hitting APIs live. Run on a schedule (nightly) or on demand.
//   pnpm metrics

import { query } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { ROOT } from "../bridge/env.mjs";

const HUB = join(ROOT, "hub");

const PROMPT = `You are refreshing Jarvis's cached business metrics. Use the available MCP tools and write the results to files under the metrics/ directory (relative to your cwd). Be concise — these are spoken summaries, not reports.

Revenue is handled by direct connectors (RevenueCat, Whop) — NOT here. Your job is the MCP-only
sources: Google Search Console and PostHog. Do all of this, in order:

1. Google Search Console (gsc MCP): list properties, then for the main ones (gluely.ai, basedhealth.ai, and any others) pull the last 28 days — total clicks, impressions, average CTR and position, plus top queries/pages and notable change vs the prior period. Write metrics/gsc.md.

2. PostHog (posthog MCP): pull the most important product signals — key event volumes, active users, and any funnel/retention highlight you can get quickly. Note which project it's scoped to. Write metrics/posthog.md.

3. Write metrics/summary.md: a tight, glanceable digest. You MAY read metrics/revenuecat-*.card.json and metrics/whop.card.json to fold current revenue numbers into the summary, but do NOT write revenue cards.

4. Write metrics/cards.json for the HUD — ONLY the gsc and posthog cards. EXACT schema (valid JSON, no comments):
{
  "updatedAt": "<ISO timestamp>",
  "cards": [
    { "source": "gsc", "title": "Search · 28d", "status": "ok|not-configured|error",
      "tiles": [ { "label": "Clicks", "value": "12.3k", "delta": "+8%", "dir": "up" } ], "note": "optional" },
    { "source": "posthog", "title": "Product", "status": "...", "tiles": [ ... ] }
  ]
}
Rules: include both cards. Each "tile" value is a short preformatted string (with $, %, k/m). "delta"/"dir" ("up"|"down"|"flat") optional. 2-4 tiles per card. If a source isn't configured, set status + tiles: [] + a short "note" hint.

5. Write metrics/_updated.json: {"updatedAt":"<ISO timestamp>","sources":{"gsc":"ok|not-configured|error","posthog":"..."}}

If a source is not configured or returns an auth error, do NOT fail — write a one-line note and mark it accordingly, then continue. Keep each file short.`;

console.log("Refreshing metrics into", join(HUB, "metrics"), "…\n");

const METRICS_DIR = join(HUB, "metrics");
const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite"]);
const WRITES = new Set(["Write", "Edit", "MultiEdit"]);

// Scoped, not bypassed: this agent may only call the data MCPs and write inside
// metrics/. Everything else (Bash, writes elsewhere) is denied.
function canUseTool(toolName, input) {
  if (toolName.startsWith("mcp__")) return { behavior: "allow", updatedInput: input };
  if (READ_ONLY.has(toolName)) return { behavior: "allow", updatedInput: input };
  if (WRITES.has(toolName)) {
    const p = input?.file_path || input?.path || "";
    const abs = p.startsWith("/") ? p : join(HUB, p);
    if (abs.startsWith(METRICS_DIR)) return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: "metrics collector may only write under metrics/" };
  }
  return { behavior: "deny", message: `tool ${toolName} not allowed for metrics collector` };
}

const stream = query({
  prompt: PROMPT,
  options: {
    cwd: HUB,
    permissionMode: "default",
    canUseTool,
    settingSources: ["user", "project"],
    model: process.env.JARVIS_MODEL || undefined,
  },
});

for await (const ev of stream) {
  if (ev.type === "assistant") {
    for (const b of ev.message?.content || []) {
      if (b.type === "tool_use") {
        const arg = b.input?.file_path || b.input?.query || b.input?.command || "";
        console.log(`  • ${b.name}${arg ? "  " + String(arg).slice(0, 70) : ""}`);
      }
    }
  } else if (ev.type === "result") {
    console.log("\n" + (ev.result || "done").trim());
  }
}
process.exit(0);
