// Runs every direct-API connector (Whop, RevenueCat, Meta…), then writes ONE compact
// metrics/_digest.md so Jarvis can answer "how's everything" with a single read.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "../bridge/env.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "connectors");
const conns = readdirSync(dir).filter((f) => f.endsWith(".mjs"));
// run each connector in ITS OWN process — isolates any process.exit() a connector calls
// (a not-configured connector exiting was killing the whole batch when imported)
await Promise.all(conns.map((f) => new Promise((res) => {
  spawn(process.execPath, [join(dir, f)], { stdio: "inherit" }).on("exit", res).on("error", res);
})));

// build the digest from the freshly-written cards + fleet
try {
  const M = join(ROOT, "hub", "metrics");
  const rj = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
  let md = `# Fleet digest — read THIS one file for "how's everything / all products"\n\n## Revenue (cached, ≤15 min old)\n`;
  for (const f of readdirSync(M).filter((x) => x.endsWith(".card.json")).sort()) {
    const c = rj(join(M, f));
    if (!c || c.status === "not-configured") continue;
    const tiles = (c.tiles || []).map((t) => `${t.label} ${t.value}`).join(" · ");
    md += `- **${c.title || c.source}**: ${tiles || c.note || "—"}\n`;
  }
  const fleet = rj(join(ROOT, "hub", "fleet.json"));
  if (fleet) {
    md += `\n## Fleet — ${fleet.total} projects, ${fleet.dirty} with uncommitted work\n`;
    md += (fleet.recent || []).slice(0, 5).map((r) => `- ${r.name}: ${r.ago}${r.dirty ? ` ⚠️${r.dirty}` : ""}`).join("\n") + "\n";
  }
  writeFileSync(join(M, "_digest.md"), md);
  console.log("wrote metrics/_digest.md");
} catch (e) { console.log("digest failed:", e?.message || e); }
