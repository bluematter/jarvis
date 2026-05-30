// Loads jarvis/.env into process.env so child processes (the Agent SDK + its MCP
// servers) inherit the keys, and ${VAR} expansion in MCP configs resolves.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const ENV_KEYS = []; // names of every key declared in .env — so we can strip them from spawned shells
const p = join(ROOT, ".env");
if (existsSync(p)) {
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) { if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); ENV_KEYS.push(m[1]); }
  }
}
