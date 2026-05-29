// Whop connector (wireflow) — direct API (no MCP exists). Writes hub/metrics/whop.card.json
// for the HUD, summing active members + trailing-30d revenue. Secret read from jarvis/.env.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../bridge/env.mjs";

const KEY = process.env.WHOP_API_KEY;
const OUT = join(ROOT, "hub", "metrics", "whop.card.json");
const api = (path) =>
  fetch("https://api.whop.com" + path, { headers: { Authorization: "Bearer " + KEY } }).then((r) => r.json());

function write(card) { writeFileSync(OUT, JSON.stringify({ ...card, updatedAt: new Date().toISOString() }, null, 2)); }

if (!KEY) { write({ source: "whop", title: "Wireflow · Whop", status: "not-configured", tiles: [], note: "WHOP_API_KEY missing in .env" }); process.exit(0); }

try {
  const active = await api("/api/v2/memberships?valid=true&per=1");
  const activeCount = active?.pagination?.total_count ?? null;

  // page payments back ~30d, sum amounts
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
  let page = 1, rev = 0, count = 0, done = false;
  while (!done && page <= 40) {
    const res = await api(`/api/v2/payments?per=50&page=${page}`);
    const rows = res?.data || [];
    if (!rows.length) break;
    for (const p of rows) {
      if ((p.created_at ?? 0) < cutoff) { done = true; break; }
      if (p.status === "refunded") continue;
      rev += Number(p.final_amount || p.subtotal || 0);
      count++;
    }
    if (page >= (res?.pagination?.total_page || 1)) break;
    page++;
  }
  const fmt = (n) => "$" + Math.round(n).toLocaleString("en-US");
  write({
    source: "whop", title: "Wireflow · Whop", status: "ok",
    tiles: [
      { label: "Active members", value: activeCount?.toLocaleString("en-US") ?? "—" },
      { label: "Revenue · 30d", value: fmt(rev) },
      { label: "Payments · 30d", value: String(count) },
    ],
  });
  console.log(`whop: ${activeCount} active members, ${fmt(rev)} / 30d (${count} payments)`);
} catch (e) {
  write({ source: "whop", title: "Wireflow · Whop", status: "error", tiles: [], note: String(e?.message || e).slice(0, 120) });
  console.log("whop error:", e?.message || e);
}
