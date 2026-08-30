// Растёт ли издержка с размером. Считаем на чистых видах: вход до сентября 2025 (preOpen)
// и полный круг в нынешнем режиме (postClose). Перезаписывает секцию growth в impact-gmx.json.
import fs from "node:fs"; import path from "node:path";
import { SP, q } from "./imp-gmx-lib.mjs";
const J = JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`, "utf8"));
const EDGES = [0, 1e3, 5e3, 20e3, 50e3, 200e3, 500e3, 1e6, 2e6, 5e6, Infinity];
const LBL = ["<$1k", "$1-5k", "$5-20k", "$20-50k", "$50-200k", "$200-500k", "$500k-1M", "$1-2M", "$2-5M", ">=$5M"];
const bx = (s) => { for (let i = EDGES.length - 2; i >= 0; i--) if (s >= EDGES[i]) return i; return 0; };
const INC = new Set([2, 3, 8]), DEC = new Set([4, 5, 6]);
const PRE = 1756684800, POST = 1759276800;
const RAW = `${SP}/imp-raw`, T = JSON.parse(fs.readFileSync(`${SP}/imp-tail.json`, "utf8"));
const MINN = 25;
const fit = (pts) => { if (pts.length < 3) return null;
  const xs = pts.map((p) => Math.log10(p.x)), ys = pts.map((p) => p.y);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  return sxx ? sxy / sxx : null; };

const out = {}, agg = { preOpen: { long: [], short: [] }, postClose: { long: [], short: [] } };
for (const f of fs.readdirSync(RAW).filter((x) => x.endsWith(".json"))) {
  const d = JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8")), t = d.t;
  const bins = { preOpen: { long: EDGES.map(() => []), short: EDGES.map(() => []) }, postClose: { long: EDGES.map(() => []), short: EDGES.map(() => []) } };
  const feed = (rows) => { for (const [ts, ot, isL, size, imp] of rows) { if (!(size > 0) || ot === 7) continue;
    const inc = INC.has(ot), dec = DEC.has(ot); if (!inc && !dec) continue;
    const v = ts < PRE ? (inc ? "preOpen" : null) : ts >= POST ? (dec ? "postClose" : null) : null; if (!v) continue;
    const r = { size, bps: 1e4 * imp / size }; bins[v][isL ? "long" : "short"][bx(size)].push(r);
    agg[v][isL ? "long" : "short"].push(r); } };
  feed(d.sample); if (d.sampleMode !== "full") feed(d.big); feed(T.byMarket[t] ?? []);
  const g = {};
  for (const v of ["preOpen", "postClose"]) for (const side of ["long", "short"]) {
    const pts = [], det = [];
    for (let b = 0; b < 10; b++) { const a = bins[v][side][b]; if (a.length < MINN) continue;
      const med = q(0.5, a.map((r) => r.bps)), sz = q(0.5, a.map((r) => r.size));
      pts.push({ x: sz, y: med }); det.push({ band: LBL[b], medSizeUsd: sz, medBps: med, n: a.length }); }
    g[`${v}_${side}`] = { bands: det, slopeBpsPerDecade: fit(pts),
      spanBps: det.length >= 2 ? det[det.length - 1].medBps - det[0].medBps : null };
  }
  out[t] = g;
}
// сводно
const aggOut = {};
for (const v of ["preOpen", "postClose"]) for (const side of ["long", "short"]) {
  const bins = EDGES.map(() => []); for (const r of agg[v][side]) bins[bx(r.size)].push(r);
  const det = []; for (let b = 0; b < 10; b++) { const a = bins[b]; if (a.length < MINN) continue;
    det.push({ band: LBL[b], medSizeUsd: q(0.5, a.map((r) => r.size)), medBps: q(0.5, a.map((r) => r.bps)),
      meanBps: a.reduce((s, r) => s + r.bps, 0) / a.length, p25: q(0.25, a.map((r) => r.bps)), p75: q(0.75, a.map((r) => r.bps)), n: a.length }); }
  aggOut[`${v}_${side}`] = { bands: det, slopeBpsPerDecade: fit(det.map((d) => ({ x: d.medSizeUsd, y: d.medBps }))),
    slopeMeanBpsPerDecade: fit(det.map((d) => ({ x: d.medSizeUsd, y: d.meanBps }))) };
}
J.growth = { note: `наклон МНК медианы bps по log10(размер), минимум ${MINN} наблюдений на полосу; знак bps сохранён, отрицательный наклон = издержка растёт с размером`,
  pooled: aggOut, byMarket: out };
fs.writeFileSync(`${SP}/impact-gmx.json`, JSON.stringify(J));
const f2 = (x, d = 2) => (x == null ? "-" : (x >= 0 ? "+" : "") + x.toFixed(d));
for (const k of Object.keys(aggOut)) { const a = aggOut[k];
  console.log(`\n${k}: наклон медианы ${f2(a.slopeBpsPerDecade, 3)} bps/декада, наклон средней ${f2(a.slopeMeanBpsPerDecade, 3)}`);
  for (const b of a.bands) console.log("   ", b.band.padEnd(10), `мед ${f2(b.medBps).padStart(8)} средн ${f2(b.meanBps).padStart(8)} [${f2(b.p25)}..${f2(b.p75)}] n=${String(b.n).padStart(6)} мед.размер $${Math.round(b.medSizeUsd).toLocaleString("en-US")}`); }
const per = Object.entries(out);
for (const k of ["preOpen_short", "preOpen_long", "postClose_short", "postClose_long"]) {
  const sl = per.map(([, v]) => v[k]?.slopeBpsPerDecade).filter((x) => x != null).sort((a, b) => a - b);
  console.log(`\n${k}: рынков с оценкой ${sl.length}, медианный наклон ${f2(sl[Math.floor(sl.length / 2)], 3)} bps/декада, наклон<0 у ${sl.filter((x) => x < 0).length}`);
}
