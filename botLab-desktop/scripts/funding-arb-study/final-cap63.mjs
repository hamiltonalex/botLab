import fs from "node:fs"; import path from "node:path";
import { all, YEAR, SP, CACHE } from "./skept-cap-lib.mjs";
const E30 = 1e30, num = (x) => Number(x) / E30;
const FULL63 = [...all.entries()].filter(([, r]) => r.length === YEAR).map(([t]) => t).sort();
console.log(`имён с полным годом: ${FULL63.length}`);

const lines = fs.readFileSync(`${CACHE}/_scan_results.csv`, "utf8").trim().split("\n");
const ix = Object.fromEntries(lines[0].split(",").map((h, i) => [h, i]));
const MAP = new Map(lines.slice(1).map((l) => { const p = l.split(","); 
  return [p[ix.token], { addr: (p[ix.gmx_market] || "").toLowerCase(), coin: p[ix.hl_coin], leg: p[ix.gmx_leg], name: p[ix.gmx_name] }]; }));

const gmx = new Map();
for (const f of ["mi.json", "mi-avax.json"]) for (const m of (JSON.parse(fs.readFileSync(`${SP}/${f}`, "utf8")).markets ?? []))
  gmx.set(m.marketToken.toLowerCase(), { availLong: num(m.availableLiquidityLong), availShort: num(m.availableLiquidityShort),
    oiLong: num(m.openInterestLong), oiShort: num(m.openInterestShort), listing: (m.listingDate || "").slice(0, 10) });

const h = JSON.parse(fs.readFileSync(`${SP}/hl.json`, "utf8"));
const hl = new Map(); h[0].universe.forEach((u, i) => hl.set(u.name, { oiUsd: Number(h[1][i].openInterest) * Number(h[1][i].markPx), vol: Number(h[1][i].dayNtlVlm) }));

const out = [], missing = [];
for (const t of FULL63) {
  const m = MAP.get(t); const g = m ? gmx.get(m.addr) : null; const H = m ? hl.get(m.coin) : null;
  if (!m || !g || !H) { missing.push(t); continue; }
  // Обе стороны сохраняем: движок перевыбирает конфиг каждый период, статическая метка врёт (поправка скептика).
  out.push({ t, coin: m.coin, name: m.name, listing: g.listing,
    availLong: g.availLong, availShort: g.availShort, oiLong: g.oiLong, oiShort: g.oiShort,
    hlOi: H.oiUsd, hlVolSnap: H.vol });
}
console.log(`сопоставлено ${out.length}, без ёмкости ${missing.length}: ${missing.join(", ")}`);
fs.writeFileSync(`${SP}/cap63.json`, JSON.stringify(out, null, 1));
fs.writeFileSync(`${SP}/full63.json`, JSON.stringify(out.map((r) => r.t)));
