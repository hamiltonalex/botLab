import fs from "node:fs"; import path from "node:path";
import { SP, CACHE, q } from "./imp-gmx-lib.mjs";
const { parseSpreadCsv } = await import("../../src/engine/format.js");

const EDGES = [0, 1e3, 5e3, 20e3, 50e3, 200e3, Infinity];
const LBL = ["<$1k", "$1-5k", "$5-20k", "$20-50k", "$50-200k", ">=$200k"];
const BIG_B = 4;                       // с этой корзины источник - полный обход крупных сделок
const INC = new Set([2, 3, 8]), DEC = new Set([4, 5, 6, 7]);
const bidx = (s) => { for (let i = EDGES.length - 2; i >= 0; i--) if (s >= EDGES[i]) return i; return 0; };

const cap63 = JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8"));
const CAP = new Map(cap63.map((r) => [r.t, r]));
const RAW = `${SP}/imp-raw`;

// час -> f_long (знак перекоса ОИ: f_long<0 значит лонги платят, рынок перегружен лонгом)
function hourFlong(token) {
  const f = fs.readdirSync(CACHE).find((x) => x.startsWith(token + "_") && x.endsWith(".csv"));
  if (!f) return null;
  const rows = parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8"));
  const m = new Map(); for (const r of rows) m.set(r.tsHour, r.f_long);
  return m;
}

function stats(arr) {
  if (!arr.length) return null;
  const bps = arr.map((r) => r.bps);
  return { n: arr.length, med: q(0.5, bps), p25: q(0.25, bps), p75: q(0.75, bps),
    p05: q(0.05, bps), p95: q(0.95, bps), mean: bps.reduce((a, b) => a + b, 0) / bps.length,
    shareRebate: bps.filter((x) => x > 0).length / bps.length,
    medSizeUsd: q(0.5, arr.map((r) => r.size)),
    medTotal: (() => { const t = arr.filter((r) => r.tbps != null).map((r) => r.tbps); return t.length ? q(0.5, t) : null; })() };
}

const out = { meta: { period: "2025-06-20..2026-06-20", chain: "arbitrum", source: "gmx.squids.live tradeActions eventName=OrderExecuted",
  bpsDef: "1e4 * priceImpactUsd / sizeDeltaUsd; знак сохранён: >0 = GMX ПЛАТИТ (сделка сокращает перекос ОИ)",
  edgesUsd: EDGES.map((x) => (x === Infinity ? null : x)), labels: LBL,
  bucketSource: "корзины 0-3 (<$50k) из представительной выборки; корзины 4-5 (>=$50k) из ПОЛНОГО обхода всех крупных сделок периода",
  orderTypes: { increase: [...INC], decrease: [...DEC] } }, markets: {}, pooled: {}, tiers: {} };

const POOL = {};                                  // key -> array
const push = (k, b, r) => ((POOL[k] ??= Array.from({ length: 6 }, () => [])), POOL[k][b].push(r));

const files = fs.readdirSync(RAW).filter((f) => f.endsWith(".json"));
console.log(`рынков с данными: ${files.length}`);
let noTail = [], grandObs = 0;

for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8"));
  const t = d.t, cap = CAP.get(t), fl = hourFlong(t);
  const exact = {}; let exSum = 0;
  for (let b = 0; b < 6; b++) { const L = d.counts[`b${b}_L`] ?? 0, S = d.counts[`b${b}_S`] ?? 0; exact[b] = { long: L, short: S, all: L + S }; exSum += L + S; }
  const bigExact = exact[4].all + exact[5].all;

  const rec = (row, src) => {
    const [ts, ot, isL, size, imp, timp] = row;
    if (!(size > 0)) return null;
    const b = bidx(size);
    if (src === "sample" && b >= BIG_B) return null;      // крупные берём только из полного обхода
    if (src === "big" && b < BIG_B) return null;
    const inc = INC.has(ot), dec = DEC.has(ot);
    if (!inc && !dec) return null;
    const pressLong = (inc && isL === 1) || (dec && isL === 0);
    const flv = fl ? fl.get(Math.floor(ts / 3600) * 3600) : undefined;
    const longHeavy = flv == null ? null : flv < 0;
    const reduces = longHeavy == null ? null : (longHeavy ? !pressLong : pressLong);
    return { b, isL, inc, size, bps: 1e4 * imp / size, tbps: timp == null ? null : 1e4 * timp / size,
      liq: ot === 7, reduces };
  };

  const cur = { long: [], short: [], longOpen: [], longClose: [], shortOpen: [], shortClose: [], reduce: [], widen: [] };
  const bins = Object.fromEntries(Object.keys(cur).map((k) => [k, Array.from({ length: 6 }, () => [])]));
  let obs = 0, liq = 0;
  for (const [src, rows] of [["sample", d.sample], ["big", d.big]])
    for (const row of rows) {
      const r = rec(row, src); if (!r) continue;
      if (r.liq) { liq++; continue; }                     // ликвидации это не наша сделка
      obs++;
      const side = r.isL ? "long" : "short";
      bins[side][r.b].push(r);
      bins[side + (r.inc ? "Open" : "Close")][r.b].push(r);
      if (r.reduces === true) bins.reduce[r.b].push(r);
      if (r.reduces === false) bins.widen[r.b].push(r);
      push(side, r.b, r); push("all", r.b, r);
      if (r.reduces === true) push("reduce", r.b, r); if (r.reduces === false) push("widen", r.b, r);
      push(side + "_" + (r.inc ? "open" : "close"), r.b, r);
    }
  grandObs += obs;
  const curves = {};
  for (const k of Object.keys(bins)) curves[k] = bins[k].map((a, b) => ({ bucket: LBL[b], ...(stats(a) || { n: 0 }) }));
  const tail = exact[4].all + exact[5].all;
  if (tail === 0) noTail.push(t);
  out.markets[t] = { totalExecuted: d.totalExecuted, sampleMode: d.sampleMode, sampleN: d.sampleN,
    bigFetched: d.bigN, bigExact, bigComplete: d.bigN >= bigExact,
    availLongUsd: cap?.availLong ?? null, availShortUsd: cap?.availShort ?? null,
    exactCountsByBucket: exact, observationsUsed: obs, liquidationsDropped: liq, curves };
}

for (const [k, arr] of Object.entries(POOL)) out.pooled[k] = arr.map((a, b) => ({ bucket: LBL[b], ...(stats(a) || { n: 0 }) }));

// тиры по свободной ликвидности GMX (сумма двух сторон)
const tierOf = (t) => { const c = CAP.get(t); const v = (c?.availLong ?? 0) + (c?.availShort ?? 0);
  return v >= 1e7 ? "A_>=10M" : v >= 1e6 ? "B_1-10M" : v >= 2e5 ? "C_200k-1M" : "D_<200k"; };
const TP = {};
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8")); const tier = tierOf(d.t);
  (TP[tier] ??= Array.from({ length: 6 }, () => []));
  for (const [src, rows] of [["sample", d.sample], ["big", d.big]])
    for (const [ts, ot, isL, size, imp] of rows) {
      if (!(size > 0)) continue; const b = bidx(size);
      if (src === "sample" && b >= BIG_B) continue; if (src === "big" && b < BIG_B) continue;
      if (ot === 7 || (!INC.has(ot) && !DEC.has(ot))) continue;
      TP[tier][b].push({ bps: 1e4 * imp / size, size, tbps: null });
    }
}
for (const [k, arr] of Object.entries(TP)) out.tiers[k] = arr.map((a, b) => ({ bucket: LBL[b], ...(stats(a) || { n: 0 }) }));

out.meta.marketsAnalyzed = files.length;
out.meta.observationsUsed = grandObs;
out.meta.marketsWithoutTradesOver50k = noTail.sort();
fs.writeFileSync(`${SP}/impact-gmx.json`, JSON.stringify(out, null, 1));
console.log("наблюдений в кривых:", grandObs, "| рынков без единой сделки >=$50k:", noTail.length);
console.log("\nСВОДНАЯ КРИВАЯ (все рынки вместе), медиана bps [p25..p75], n:");
for (const side of ["long", "short"]) {
  console.log(` сторона GMX = ${side}`);
  for (const r of out.pooled[side]) console.log("   ", r.bucket.padEnd(9), r.n ? `${r.med.toFixed(2).padStart(8)} [${r.p25.toFixed(2)}..${r.p75.toFixed(2)}]  n=${r.n}  доля_с_рибейтом=${(100 * r.shareRebate).toFixed(0)}%` : "нет наблюдений");
}
console.log("\nПО ЗНАКУ ПЕРЕКОСА (сделка сокращает перекос ОИ / углубляет его):");
for (const k of ["reduce", "widen"]) { console.log(` ${k === "reduce" ? "сокращает" : "углубляет"}`);
  for (const r of out.pooled[k]) console.log("   ", r.bucket.padEnd(9), r.n ? `${r.med.toFixed(2).padStart(8)} [${r.p25.toFixed(2)}..${r.p75.toFixed(2)}]  n=${r.n}` : "нет"); }
console.log("\nПО ТИРАМ ЛИКВИДНОСТИ:");
for (const k of Object.keys(out.tiers).sort()) { console.log(" ", k);
  for (const r of out.tiers[k]) console.log("   ", r.bucket.padEnd(9), r.n ? `${r.med.toFixed(2).padStart(8)} [${r.p25.toFixed(2)}..${r.p75.toFixed(2)}] n=${r.n}` : "нет"); }
