// Probe: what MCP servers + tools does the Agent SDK load with our options?
import { query } from "@anthropic-ai/claude-agent-sdk";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "hub");
const stream = query({
  prompt: "Reply with exactly: ok",
  options: { cwd: HUB, settingSources: ["user", "project"], permissionMode: "bypassPermissions" },
});
for await (const ev of stream) {
  if (ev.type === "system" && ev.subtype === "init") {
    console.log("MCP SERVERS:", JSON.stringify(ev.mcp_servers, null, 2));
    console.log("TOOLS:", (ev.tools || []).filter((t) => t.startsWith("mcp__")).join(", ") || "(no mcp tools)");
    break;
  }
}
process.exit(0);
