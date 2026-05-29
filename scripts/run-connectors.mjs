// Runs every direct-API connector in scripts/connectors/ (non-MCP sources like
// Whop, Telegram Stars). Each writes hub/metrics/<source>.card.json. Safe to schedule.
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "connectors");
const files = readdirSync(dir).filter((f) => f.endsWith(".mjs"));
for (const f of files) {
  try { await import(join(dir, f)); } catch (e) { console.log(`${f} failed:`, e?.message || e); }
}
