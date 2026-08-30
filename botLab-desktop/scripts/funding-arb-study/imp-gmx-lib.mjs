import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
export const SP = STUDY_DATA;
export const CACHE = STUDY_CACHE;
export const T0 = 1750402800, T1 = 1781938800;
export const URL_ARB = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
export const URL_AVAX = "https://gmx.squids.live/gmx-synthetics-avalanche:prod/api/graphql";
export const E30 = 1e30;

export async function gql(url, query, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
      return j.data;
    } catch (e) { lastErr = e; await new Promise((s) => setTimeout(s, 500 * (i + 1) * (i + 1))); }
  }
  throw lastErr;
}

// token -> {addr, chain, coin, name}
export function marketMap() {
  const lines = fs.readFileSync(`${CACHE}/_scan_results.csv`, "utf8").trim().split("\n");
  const ix = Object.fromEntries(lines[0].split(",").map((h, i) => [h, i]));
  const chain = new Map();
  for (const [f, c] of [["mi.json", "arbitrum"], ["mi-avax.json", "avalanche"]])
    for (const m of JSON.parse(fs.readFileSync(`${SP}/${f}`, "utf8")).markets ?? []) chain.set(m.marketToken.toLowerCase(), c);
  const out = new Map();
  for (const l of lines.slice(1)) {
    const p = l.split(",");
    const addr = (p[ix.gmx_market] || "").trim();
    out.set(p[ix.token], { addr, lc: addr.toLowerCase(), chain: chain.get(addr.toLowerCase()) || null, coin: p[ix.hl_coin], name: p[ix.gmx_name] });
  }
  return out;
}
export const q = (n, a) => { const s = [...a].sort((x, y) => x - y); if (!s.length) return null;
  const i = (s.length - 1) * n, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
