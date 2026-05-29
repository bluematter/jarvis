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

Do all of this, in order:

1. RevenueCat (revenuecat MCP): pull the key revenue picture across all apps/projects — active subscriptions, trials, MRR/revenue, and notable week-over-week movement. Write metrics/revenuecat.md.

2. Google Search Console (gsc MCP): list properties, then for each (or the top ones) pull the last 28 days of search performance — total clicks, impressions, average CTR and position, plus top queries and top pages, and any notable change vs the prior period. Write metrics/gsc.md.

3. PostHog (posthog MCP): pull the most important product signals for the current project — key event volumes, active users, and any funnel/retention highlight you can get quickly. Write metrics/posthog.md.

4. Write metrics/summary.md: a tight, glanceable digest with the headline numbers from all three sources and the 3-5 most notable changes or things worth Michael's attention.

5. Write metrics/_updated.json: {"updatedAt":"<ISO timestamp>","sources":{"revenuecat":"ok|not-configured|error","gsc":"...","posthog":"..."}}

If a source is not configured or returns an auth error, do NOT fail — write a one-line "not configured yet" note in its file and mark it accordingly in _updated.json, then continue. Keep each file short.`;

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
