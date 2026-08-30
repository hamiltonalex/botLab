import { CACHE as STUDY_CACHE } from "./paths.mjs";
import fs from "node:fs";
export const EP = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
export const CACHE = STUDY_CACHE;
export const T0 = 1750402800, T1 = 1781938800;
export async function gql(q, v, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(EP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
      return j.data;
    } catch (e) { if (i === tries - 1) throw e; await new Promise(z => setTimeout(z, 700 * (i + 1))); }
  }
}
// token -> {market, coin}
export function scan() {
  const txt = fs.readFileSync(CACHE + "/_scan_results.csv", "utf8").trim().split("\n");
  const h = txt[0].split(","); const iT = h.indexOf("token"), iM = h.indexOf("gmx_market"), iC = h.indexOf("hl_coin"), iN = h.indexOf("gmx_name");
  const m = new Map();
  for (const line of txt.slice(1)) { const c = line.split(","); if (!m.has(c[iT])) m.set(c[iT], { market: c[iM], coin: c[iC], name: c[iN] }); }
  return m;
}
// читает кэш токена -> [{tsHour, f_long, f_short, b_long, b_short, hl_rate}]
export function cacheRows(tok) {
  const p = `${CACHE}/${tok}_${T0}_${T1}.csv`;
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").trim().split("\n");
  const h = lines[0].split(",");
  const idx = Object.fromEntries(h.map((c, i) => [c.trim(), i]));
  return lines.slice(1).map(l => { const c = l.split(","); const o = {}; for (const k in idx) o[k] = c[idx[k]]; return o; });
}
