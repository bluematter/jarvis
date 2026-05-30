// Crypto wallet connector — sums an EVM wallet's holdings in USD across MULTIPLE chains. No API key:
// balances from Blockscout (per chain), prices from Blockscout + GeckoTerminal (on-chain DEX prices).
// Address read from jarvis/.env (WALLET_ADDRESS) and NEVER committed. Writes hub/metrics/wallet.card.json.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../bridge/env.mjs";

const ADDR = (process.env.WALLET_ADDRESS || "").trim();
const CHAINS = (process.env.WALLET_CHAINS || "base,ethereum,polygon,arbitrum,optimism").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const LABEL = process.env.WALLET_LABEL || "Crypto · Wallet";
const BS = { base: "https://base.blockscout.com", ethereum: "https://eth.blockscout.com", polygon: "https://polygon.blockscout.com", arbitrum: "https://arbitrum.blockscout.com", optimism: "https://optimism.blockscout.com" };
const GT = { base: "base", ethereum: "eth", polygon: "polygon_pos", arbitrum: "arbitrum", optimism: "optimism" };
const ETH_NATIVE = new Set(["base", "ethereum", "arbitrum", "optimism"]); // these chains' native coin is ETH
const STABLE = /^(usdc|usdt|dai|usdbc|usds|musd|usde|pyusd)$/i;
const OUT = join(ROOT, "hub", "metrics", "wallet.card.json");
const write = (c) => writeFileSync(OUT, JSON.stringify({ ...c, updatedAt: new Date().toISOString() }, null, 2));
const fmt = (n) => "$" + Math.round(n).toLocaleString("en-US");
async function getJSON(u, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 20000);
    try { return await fetch(u, { headers: { "User-Agent": "jarvis/1.0", Accept: "application/json" }, signal: c.signal }).then((r) => r.json()).finally(() => clearTimeout(t)); }
    catch (e) { clearTimeout(t); if (i === tries - 1) throw e; }
  }
}

if (!ADDR) { write({ source: "wallet", title: LABEL, status: "not-configured", tiles: [], note: "WALLET_ADDRESS missing in .env" }); process.exit(0); }

try {
  let total = 0, stable = 0, ethTotal = 0, chainsWithValue = 0;
  const all = []; // {sym, usd}
  for (const ch of CHAINS) {
    const bs = BS[ch]; if (!bs) continue;
    try {
      const info = await getJSON(`${bs}/api/v2/addresses/${ADDR}`);
      const nat = Number(info?.coin_balance || 0) / 1e18, natUsd = nat * Number(info?.exchange_rate || 0);
      const toks = (await getJSON(`${bs}/api/v2/addresses/${ADDR}/tokens?type=ERC-20`))?.items || [];
      const holds = toks.map((t) => ({
        sym: t.token?.symbol || "?", addr: (t.token?.address || t.token?.address_hash || "").toLowerCase(),
        bal: Number(t.value || 0) / 10 ** Number(t.token?.decimals || 18), rate: t.token?.exchange_rate ? Number(t.token.exchange_rate) : null,
      }));
      const need = holds.filter((h) => h.rate == null && h.addr).map((h) => h.addr), px = {};
      for (let i = 0; i < need.length; i += 30) {
        try {
          const d = await getJSON(`https://api.geckoterminal.com/api/v2/simple/networks/${GT[ch] || ch}/token_price/${need.slice(i, i + 30).join(",")}`);
          const m = d?.data?.attributes?.token_prices || {}; for (const a in m) if (m[a]) px[a.toLowerCase()] = Number(m[a]);
        } catch {}
      }
      let chSub = natUsd;
      if (natUsd > 1) all.push({ sym: ETH_NATIVE.has(ch) ? "ETH" : ch.toUpperCase(), usd: natUsd });
      if (ETH_NATIVE.has(ch)) ethTotal += nat;
      for (const h of holds) {
        const usd = h.bal * (h.rate ?? px[h.addr] ?? 0); if (!usd) continue;
        chSub += usd; if (STABLE.test(h.sym)) stable += usd; all.push({ sym: h.sym, usd });
      }
      total += chSub;
      if (chSub > 1) chainsWithValue++;
    } catch (e) { console.log(`wallet ${ch}: ${String(e?.message || e).slice(0, 40)}`); }
  }
  // merge by symbol for the "top holdings" note
  const merged = {};
  for (const x of all) merged[x.sym] = (merged[x.sym] || 0) + x.usd;
  const top = Object.entries(merged).filter(([, u]) => u > 1).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, u]) => `${s} ${fmt(u)}`).join(" · ");

  const crypto = Math.max(0, total - stable), stablePct = total ? Math.round((stable / total) * 100) : 0;
  write({
    source: "wallet", title: LABEL, status: "ok",
    tiles: [
      { label: "Total", value: fmt(total) },
      { label: "Stablecoins", value: fmt(stable), delta: stablePct + "% dry powder", dir: "flat" },
      { label: "In crypto", value: fmt(crypto), delta: ethTotal.toFixed(2) + " ETH", dir: "flat" },
    ],
    note: top ? "Holdings: " + top + ` · across ${chainsWithValue} chains` : null,
  });
  console.log("wallet:", fmt(total), `across ${chainsWithValue} chains`);
} catch (e) {
  write({ source: "wallet", title: LABEL, status: "error", tiles: [], note: String(e?.message || e).slice(0, 120) });
}
