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
  // Whop API v1 (v2 is refused from 2026-11-13). Cursor pagination, newest first.
  const company = process.env.WHOP_COMPANY_ID || "biz_N01AiCpZ8lwjT1";
  const active = await api(`/api/v1/memberships?company_id=${company}&statuses[]=active&first=1`);
  const activeCount = active?.total_count ?? null;

  // page payments back ~30d, sum paid USD totals net of refunds
  const cutoff = Date.now() - 30 * 86400 * 1000;
  let after = "", pages = 0, rev = 0, count = 0, done = false;
  while (!done && pages < 40) {
    const res = await api(`/api/v1/payments?company_id=${company}&statuses[]=paid&first=100${after ? `&after=${after}` : ""}`);
    const rows = res?.data || [];
    if (!rows.length) break;
    for (const p of rows) {
      if (Date.parse(p.created_at) < cutoff) { done = true; break; }
      if (p.status !== "paid") continue;
      rev += Number(p.usd_total ?? p.total ?? 0) - Number(p.refunded_amount || 0);
      count++;
    }
    if (!res?.page_info?.has_next_page) break;
    after = res.page_info.end_cursor;
    pages++;
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
