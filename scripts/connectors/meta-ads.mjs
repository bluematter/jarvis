// Meta Ads connector — direct Marketing API (no third party). Pulls account-level
// 30d insights and writes hub/metrics/meta-ads.card.json. Token + account from .env.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../bridge/env.mjs";

const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCT = process.env.META_AD_ACCOUNT_ID; // "act_123..." or just the number
const VER = process.env.META_API_VERSION || "v22.0";
const OUT = join(ROOT, "hub", "metrics", "meta-ads.card.json");
const write = (c) => writeFileSync(OUT, JSON.stringify({ source: "meta-ads", title: "BasedHealth · Meta Ads", updatedAt: new Date().toISOString(), ...c }, null, 2));

if (!TOKEN || !ACCT) { write({ status: "not-configured", tiles: [], note: "Set META_ACCESS_TOKEN + META_AD_ACCOUNT_ID in .env" }); process.exit(0); }
const acct = String(ACCT).startsWith("act_") ? ACCT : "act_" + ACCT;
const usd = (n) => "$" + Math.round(Number(n || 0)).toLocaleString("en-US");

try {
  const fields = "spend,impressions,clicks,cpm,ctr,cpc,actions,cost_per_action_type,purchase_roas";
  const url = `https://graph.facebook.com/${VER}/${acct}/insights?fields=${fields}&date_preset=last_30d&access_token=${encodeURIComponent(TOKEN)}`;
  const res = await (await fetch(url)).json();
  if (res.error) { write({ status: "error", tiles: [], note: String(res.error.message || "").slice(0, 150) }); console.log("meta error:", res.error.message); process.exit(0); }
  const d = (res.data && res.data[0]) || {};
  const roas = Array.isArray(d.purchase_roas) && d.purchase_roas[0] ? Number(d.purchase_roas[0].value) : null;
  const tiles = [
    { label: "Spend · 30d", value: usd(d.spend) },
    { label: "CPM", value: usd(d.cpm) },
    { label: "CTR", value: Number(d.ctr || 0).toFixed(2) + "%" },
    { label: "ROAS", value: roas != null ? roas.toFixed(2) + "×" : "—" },
  ];
  write({ status: d.spend ? "ok" : "ok", tiles, note: d.spend ? null : "connected — no spend in the last 30d yet" });
  console.log(`meta: spend ${usd(d.spend)}/30d · CPM ${usd(d.cpm)} · CTR ${Number(d.ctr || 0).toFixed(2)}% · ROAS ${roas ?? "—"}`);
} catch (e) {
  write({ status: "error", tiles: [], note: String(e?.message || e).slice(0, 150) });
  console.log("meta error:", e?.message || e);
}
