// RevenueCat connector — pulls each project's overview metrics directly from the v2
// API (reliable, no agent needed) and writes one card per product. Keys from .env.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../bridge/env.mjs";

const PROJECTS = [
  { key: process.env.REVENUECAT_GLUELY_KEY, slug: "gluely", label: "Gluely" },
  { key: process.env.REVENUECAT_BASEDHEALTH_KEY, slug: "basedhealth", label: "BasedHealth" },
];
const api = (path, key) =>
  fetch("https://api.revenuecat.com/v2" + path, { headers: { Authorization: "Bearer " + key } }).then((r) => r.json());
const usd = (n) => "$" + Math.round(Number(n || 0)).toLocaleString("en-US");
const num = (n) => Number(n || 0).toLocaleString("en-US");

for (const p of PROJECTS) {
  const OUT = join(ROOT, "hub", "metrics", `revenuecat-${p.slug}.card.json`);
  const card = (c) => writeFileSync(OUT, JSON.stringify({ source: `revenuecat-${p.slug}`, title: `${p.label} · Revenue`, updatedAt: new Date().toISOString(), ...c }, null, 2));
  if (!p.key) { card({ status: "not-configured", tiles: [], note: `REVENUECAT_${p.slug.toUpperCase()}_KEY missing in .env` }); continue; }
  try {
    const proj = await api("/projects", p.key);
    const id = proj?.items?.[0]?.id;
    const ov = await api(`/projects/${id}/metrics/overview`, p.key);
    const m = Object.fromEntries((ov.metrics || []).map((x) => [x.id, x.value ?? x.last_value]));
    card({ status: "ok", tiles: [
      { label: "MRR", value: usd(m.mrr) },
      { label: "Active subs", value: num(m.active_subscriptions) },
      { label: "Trials", value: num(m.active_trials) },
      { label: "Revenue · 28d", value: usd(m.revenue) },
    ] });
    console.log(`revenuecat ${p.label}: MRR ${usd(m.mrr)}, ${num(m.active_subscriptions)} subs`);
  } catch (e) {
    card({ status: "error", tiles: [], note: String(e?.message || e).slice(0, 120) });
    console.log(`revenuecat ${p.label} error:`, e?.message || e);
  }
}
