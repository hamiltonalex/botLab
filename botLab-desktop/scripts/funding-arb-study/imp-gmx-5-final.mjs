// Строит impact-gmx.json: кривые influence(размер, сторона) по рынкам, по тирам и сводно,
// плюс готовые к интерполяции узлы и ответ на вопрос "растёт ли издержка с размером".
import fs from "node:fs"; import path from "node:path";
import { SP, CACHE, q } from "./imp-gmx-lib.mjs";
const { parseSpreadCsv } = await import("../../src/engine/format.js");

const EDGES = [0, 1e3, 5e3, 20e3, 50e3, 200e3, Infinity];
const LBL = ["<$1k", "$1-5k", "$5-20k", "$20-50k", "$50-200k", ">=$200k"];
const BIG_B = 4, INC = new Set([2, 3, 8]), DEC = new Set([4, 5, 6, 7]);
const bidx = (s) => { for (let i = EDGES.length - 2; i >= 0; i--) if (s >= EDGES[i]) return i; return 0; };
const CAP = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((r) => [r.t, r]));
const RAW = `${SP}/imp-raw`;

function hourFlong(token) {
  const f = fs.readdirSync(CACHE).find((x) => x.startsWith(token + "_") && x.endsWith(".csv"));
  if (!f) return null;
  const m = new Map(); for (const r of parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8"))) m.set(r.tsHour, r.f_long);
  return m;
}
const st = (a) => { if (!a.length) return { n: 0 }; const b = a.map((r) => r.bps);
  return { n: a.length, med: q(0.5, b), p25: q(0.25, b), p75: q(0.75, b), p05: q(0.05, b), p95: q(0.95, b),
    mean: b.reduce((x, y) => x + y, 0) / b.length, shareRebate: b.filter((x) => x > 0).length / b.length,
    shareZero: b.filter((x) => x === 0).length / b.length, medSizeUsd: q(0.5, a.map((r) => r.size)),
    medTotalBps: (() => { const t = a.filter((r) => r.tbps != null).map((r) => r.tbps); return t.length ? q(0.5, t) : null; })() }; };
const row6 = (bins) => bins.map((a, b) => ({ bucket: LBL[b], loUsd: EDGES[b], hiUsd: EDGES[b + 1] === Infinity ? null : EDGES[b + 1], ...st(a) }));

const out = { meta: {
  period: "2025-06-20..2026-06-20 (ts 1750402800..1781938800)", chain: "arbitrum",
  source: "GraphQL gmx.squids.live/gmx-synthetics-arbitrum:prod, сущность tradeActions, eventName=OrderExecuted, sizeDeltaUsd>0",
  bpsDef: "bps = 1e4 * priceImpactUsd / sizeDeltaUsd. Знак сохранён: bps>0 значит GMX ПЛАТИТ трейдеру (сделка сокращает перекос ОИ), bps<0 значит трейдер платит.",
  sides: "long/short = поле isLong. Конфиг A (шорт GMX) читает сторону short, конфиг B (лонг GMX) сторону long.",
  bucketSource: "корзины <$50k из представительной выборки, корзины >=$50k из отдельного полного обхода всех сделок >=$50k (на самых активных рынках якорная выборка)",
  exactCounts: "exactCountsByBucket даёт ТОЧНОЕ число исполненных сделок в корзине за период (запрос totalCount, без выборки)",
  liquidations: "orderType=7 (ликвидации) исключены из кривых",
  edgesUsd: EDGES.map((x) => (x === Infinity ? null : x)), labels: LBL,
}, markets: {}, pooled: {}, tiers: {}, interp: {}, growth: {} };

const POOL = {}, TP = {};
const add = (o, k, b, r) => ((o[k] ??= Array.from({ length: 6 }, () => [])), o[k][b].push(r));
const tierOf = (t) => { const c = CAP.get(t); const v = (c?.availLong ?? 0) + (c?.availShort ?? 0);
  return v >= 1e7 ? "A_свободная_ликвидность>=10M" : v >= 1e6 ? "B_1-10M" : v >= 2e5 ? "C_200k-1M" : "D_<200k"; };

const files = fs.readdirSync(RAW).filter((f) => f.endsWith(".json")).sort();
let grandObs = 0, noBig = [], no200 = [];
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8"));
  const t = d.t, cap = CAP.get(t), fl = hourFlong(t), tier = tierOf(t);
  const exact = {}; for (let b = 0; b < 6; b++) exact[b] = { long: d.counts[`b${b}_L`] ?? 0, short: d.counts[`b${b}_S`] ?? 0, all: (d.counts[`b${b}_L`] ?? 0) + (d.counts[`b${b}_S`] ?? 0) };
  if (exact[4].all + exact[5].all === 0) noBig.push(t);
  if (exact[5].all === 0) no200.push(t);

  const keys = ["long", "short", "longOpen", "longClose", "shortOpen", "shortClose", "reduce", "widen", "shortReduce", "shortWiden", "longReduce", "longWiden"];
  const bins = Object.fromEntries(keys.map((k) => [k, Array.from({ length: 6 }, () => [])]));
  let obs = 0, liq = 0;
  // при полном обходе рынка всё берём из sample (там уже все сделки), при якорной выборке
  // мелкие корзины из sample, крупные из отдельного полного прохода big
  const FULL = d.sampleMode === "full";
  for (const [src, rows] of [["sample", d.sample], ["big", FULL ? [] : d.big]]) for (const [ts, ot, isL, size, imp, timp] of rows) {
    if (!(size > 0)) continue; const b = bidx(size);
    if (!FULL && (src === "sample" ? b >= BIG_B : b < BIG_B)) continue;
    if (ot === 7) { liq++; continue; }
    const inc = INC.has(ot), dec = DEC.has(ot); if (!inc && !dec) continue;
    const flv = fl ? fl.get(Math.floor(ts / 3600) * 3600) : undefined;
    const pressLong = (inc && isL === 1) || (dec && isL === 0);
    const reduces = flv == null ? null : (flv < 0 ? !pressLong : pressLong);
    const r = { size, bps: 1e4 * imp / size, tbps: timp == null ? null : 1e4 * timp / size };
    obs++; const side = isL ? "long" : "short";
    bins[side][b].push(r); bins[side + (inc ? "Open" : "Close")][b].push(r);
    if (reduces === true) { bins.reduce[b].push(r); bins[side + "Reduce"][b].push(r); }
    if (reduces === false) { bins.widen[b].push(r); bins[side + "Widen"][b].push(r); }
    add(POOL, side, b, r); add(POOL, "all", b, r); add(TP, tier, b, r); add(TP, tier + "|" + side, b, r);
    const reg = ts < 1756684800 ? "pre" : ts >= 1759276800 ? "post" : null;   // до 01.09.2025 / с 01.10.2025
    if (reg) { add(POOL, `${reg}_${side}`, b, r); add(POOL, `${reg}_${side}_${inc ? "open" : "close"}`, b, r); }
    if (reduces === true) add(POOL, "reduce", b, r); if (reduces === false) add(POOL, "widen", b, r);
    add(POOL, side + (inc ? "Open" : "Close"), b, r);
  }
  grandObs += obs;
  out.markets[t] = { totalExecuted: d.totalExecuted, tier, sampleMode: d.sampleMode, sampleN: d.sampleN,
    bigMode: d.bigMode ?? "full", bigFetched: d.bigN, bigExact: d.bigExact ?? (exact[4].all + exact[5].all),
    availLongUsd: cap?.availLong ?? null, availShortUsd: cap?.availShort ?? null,
    exactCountsByBucket: exact, observationsUsed: obs, liquidationsDropped: liq,
    curves: Object.fromEntries(keys.map((k) => [k, row6(bins[k])])) };
}
for (const [k, a] of Object.entries(POOL)) out.pooled[k] = row6(a);
for (const [k, a] of Object.entries(TP)) out.tiers[k] = row6(a);

// ---- узлы для интерполяции: медианный размер корзины -> медиана bps (и p25 как неблагоприятный сценарий)
const MINN = 30;
const nodes = (curve) => curve.filter((r) => r.n >= MINN).map((r) => ({ sizeUsd: r.medSizeUsd, bps: r.med, adverseBps: r.p25, n: r.n }));
for (const t of Object.keys(out.markets)) out.interp[t] = { long: nodes(out.markets[t].curves.long), short: nodes(out.markets[t].curves.short) };
out.interp._pooled = { long: nodes(out.pooled.long), short: nodes(out.pooled.short) };
out.interp._tiers = Object.fromEntries(Object.entries(out.tiers).filter(([k]) => k.includes("|")).map(([k, v]) => [k, nodes(v)]));
out.meta.interpHowTo = "Кусочно-линейная интерполяция bps по log10(sizeUsd) между узлами interp[token][side]; вне диапазона - крайний узел. Если узлов у рынка мало (n<30 в корзине), падать на interp._tiers[tier|side], затем на interp._pooled[side].";

// ---- растёт ли издержка с размером
const growth = {};
for (const t of Object.keys(out.markets)) {
  const g = {};
  for (const side of ["long", "short"]) {
    const c = out.markets[t].curves[side].filter((r) => r.n >= MINN);
    if (c.length < 2) { g[side] = { verdict: "мало наблюдений", buckets: c.length }; continue; }
    const a = c[0], z = c[c.length - 1];
    // МНК по log10(размер): наклон bps на декаду
    const xs = c.map((r) => Math.log10(r.medSizeUsd)), ys = c.map((r) => r.med);
    const mx = xs.reduce((p, q2) => p + q2, 0) / xs.length, my = ys.reduce((p, q2) => p + q2, 0) / ys.length;
    let sxy = 0, sxx = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    g[side] = { fromBucket: a.bucket, fromBps: a.med, toBucket: z.bucket, toBps: z.med,
      deltaBps: z.med - a.med, slopeBpsPerDecade: sxx ? sxy / sxx : null,
      adverseFromBps: a.p25, adverseToBps: z.p25, adverseDeltaBps: z.p25 - a.p25, buckets: c.length };
  }
  growth[t] = g;
}
out.growth = growth;
out.meta.marketsAnalyzed = files.length;
out.meta.observationsUsed = grandObs;
out.meta.marketsWithNoTradeOver50k = noBig.sort();
out.meta.marketsWithNoTradeOver200k = no200.sort();
fs.writeFileSync(`${SP}/impact-gmx.json`, JSON.stringify(out));
console.log(`рынков ${files.length}, наблюдений ${grandObs}; без сделок >=$50k: ${noBig.length}; без сделок >=$200k: ${no200.length}`);

const pr = (c) => c.map((r) => r.n ? `${r.med.toFixed(2)}[${r.p25.toFixed(2)}/${r.p75.toFixed(2)}]n=${r.n}` : "нет").join("  ");
console.log("\n=== СВОДНАЯ КРИВАЯ (все 63 рынка вместе), медиана bps [p25/p75] ===");
for (const k of ["short", "long", "shortOpen", "shortClose", "longOpen", "longClose", "reduce", "widen"]) {
  console.log(`\n${k}`); for (const r of out.pooled[k]) console.log("  ", r.bucket.padEnd(9), r.n ? `мед ${r.med.toFixed(3).padStart(8)}  p25 ${r.p25.toFixed(3).padStart(8)}  p75 ${r.p75.toFixed(3).padStart(8)}  n=${String(r.n).padStart(7)}  рибейт ${(100 * r.shareRebate).toFixed(0)}%  ноль ${(100 * r.shareZero).toFixed(0)}%  totalImpact_мед ${r.medTotalBps == null ? "-" : r.medTotalBps.toFixed(3)}` : "нет наблюдений");
}
// круг: открытие + закрытие на одной стороне GMX (в v2.2 часть импакта отложена до закрытия)
out.roundTrip = {};
for (const side of ["short", "long"]) {
  out.roundTrip[side] = out.pooled[side + "Open"].map((o, b) => { const c = out.pooled[side + "Close"][b];
    return { bucket: LBL[b], openMedBps: o.n ? o.med : null, closeMedBps: c.n ? c.med : null,
      roundTripMedBps: o.n && c.n ? o.med + c.med : null,
      openAdverseBps: o.n ? o.p25 : null, closeAdverseBps: c.n ? c.p25 : null,
      roundTripAdverseBps: o.n && c.n ? o.p25 + c.p25 : null, nOpen: o.n, nClose: c.n }; });
}
out.meta.roundTripNote = "roundTripMedBps = медиана открытия + медиана закрытия на той же стороне GMX. Положительное значение = GMX в сумме ПЛАТИТ за круг. Сравнивать с DEFAULT_COSTS.gmxImpact, который в модели равен -10 bps на КАЖДУЮ ногу.";
fs.writeFileSync(`${SP}/impact-gmx.json`, JSON.stringify(out));
console.log("\n=== КРУГ (открытие+закрытие) по стороне GMX, bps ===");
for (const side of ["short", "long"]) { console.log(` сторона ${side} (конфиг ${side === "short" ? "A" : "B"})`);
  for (const r of out.roundTrip[side]) console.log("   ", r.bucket.padEnd(9), r.roundTripMedBps == null ? "нет" : `откр ${r.openMedBps.toFixed(3).padStart(7)} + закр ${r.closeMedBps.toFixed(3).padStart(7)} = ${r.roundTripMedBps.toFixed(3).padStart(7)} bps (неблагопр. ${r.roundTripAdverseBps.toFixed(2)})  n=${r.nOpen}/${r.nClose}`); }
console.log("\n=== РЕЖИМЫ ПРОТОКОЛА: до 01.09.2025 impact берётся на ОБЕИХ ногах, с 01.10.2025 открытие даёт ровно ноль (отложенный impact) ===");
out.regimes = {};
for (const reg of ["pre", "post"]) for (const side of ["short", "long"]) {
  const o = out.pooled[`${reg}_${side}_open`], c = out.pooled[`${reg}_${side}_close`];
  if (!o || !c) continue;
  out.regimes[`${reg}_${side}`] = o.map((r, b) => ({ bucket: LBL[b], openMedBps: r.n ? r.med : null, openShareZero: r.n ? r.shareZero : null,
    closeMedBps: c[b].n ? c[b].med : null, roundTripMedBps: r.n && c[b].n ? r.med + c[b].med : null,
    roundTripAdverseBps: r.n && c[b].n ? r.p25 + c[b].p25 : null, nOpen: r.n, nClose: c[b].n }));
}
out.meta.regimeNote = "GMX v2 в сентябре 2025 перешёл на отложенный impact: у ордеров увеличения позиции priceImpactUsd стал ровно нулевым (доля нулей 100%), весь impact теперь оседает на закрытии. Для модели это значит ОДИН заряд impact на круг, а не два.";
for (const k of Object.keys(out.regimes)) { console.log(` ${k}`);
  for (const r of out.regimes[k]) console.log("   ", r.bucket.padEnd(9), r.roundTripMedBps == null ? "нет" : `откр ${r.openMedBps.toFixed(3).padStart(7)} (нулей ${(100 * r.openShareZero).toFixed(0)}%) + закр ${r.closeMedBps.toFixed(3).padStart(7)} = круг ${r.roundTripMedBps.toFixed(3).padStart(7)} bps  n=${r.nOpen}/${r.nClose}`); }
fs.writeFileSync(`${SP}/impact-gmx.json`, JSON.stringify(out));

console.log("\n=== ПО ТИРАМ СВОБОДНОЙ ЛИКВИДНОСТИ GMX ===");
for (const k of Object.keys(out.tiers).filter((k) => !k.includes("|")).sort()) {
  console.log(` ${k}`); for (const r of out.tiers[k]) console.log("   ", r.bucket.padEnd(9), r.n ? `мед ${r.med.toFixed(3).padStart(8)} p25 ${r.p25.toFixed(3).padStart(8)} p75 ${r.p75.toFixed(3).padStart(8)} n=${String(r.n).padStart(6)}` : "нет");
}
