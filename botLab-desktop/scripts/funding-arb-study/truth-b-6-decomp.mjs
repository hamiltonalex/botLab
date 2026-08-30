import fs from "node:fs";
import { analyse, loadCache } from "./truth-b-5-realized.mjs";
import { cacheRows } from "./truth-b-lib.mjs";
const YR = 3600 * 8760, CEIL = 1e-7;
const T = process.argv.slice(2);
function pct(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
console.log("        |------------- КЭШ, |f_short| по всем 8761 часам, %годовых -------------|  ФАКТ");
console.log("токен     среднее    медиана      p99     макс   доля_суммы_в_аномалиях  ср.без_аном   %год");
const rows = [];
for (const t of T) {
  const cr = cacheRows(t); const v = cr.map(r => Math.abs(+r.f_short));
  const sum = v.reduce((a, b) => a + b, 0);
  const anom = v.filter(x => x > CEIL), clean = v.filter(x => x <= CEIL);
  const sAnom = anom.reduce((a, b) => a + b, 0);
  const a = analyse(t); const paid = a.iv.filter(x => x.fund > 0);
  const fact = paid.reduce((s, x) => s + x.fund, 0) / paid.reduce((s, x) => s + x.nt, 0);
  const meanClean = clean.reduce((a2, b) => a2 + b, 0) / clean.length;
  rows.push({ t, mean: sum / v.length, med: pct(v, .5), p99: pct(v, .99), max: Math.max(...v), share: sAnom / sum, meanClean, fact });
  const r = rows[rows.length - 1];
  console.log(t.padEnd(9), (r.mean*YR*100).toFixed(0).padStart(8), (r.med*YR*100).toFixed(1).padStart(9),
    (r.p99*YR*100).toFixed(0).padStart(9), (r.max*YR*100).toExponential(2).padStart(9),
    (100*r.share).toFixed(1).padStart(18)+"%", (r.meanClean*YR*100).toFixed(1).padStart(12), (r.fact*YR*100).toFixed(1).padStart(8));
}
fs.writeFileSync("truth-b-decomp.json", JSON.stringify(rows, null, 1));
const g = rows.map(r => r.meanClean / r.fact);
console.log(`\nср.без_аномалий / ФАКТ: медиана ${pct(g,.5).toFixed(2)}x  (диапазон ${Math.min(...g).toFixed(2)}..${Math.max(...g).toFixed(2)})`);
const g2 = rows.map(r => r.mean / r.fact);
console.log(`полное среднее кэша / ФАКТ: медиана ${pct(g2,.5).toFixed(1)}x  (диапазон ${Math.min(...g2).toFixed(1)}..${Math.max(...g2).toFixed(1)})`);
