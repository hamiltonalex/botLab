import fs from "node:fs";
import { loadY1, loadY2, listingMap, MAJORS, M, P, DEFAULT_COSTS, roundTripCost, SP } from "./skept-age-lib.mjs";
const y1 = loadY1(), y2 = loadY2(), L = listingMap();
const cap = new Map(JSON.parse(fs.readFileSync(`${SP}/capacity.json`, "utf8")).map((r) => [r.t, r]));
const TOK = MAJORS.filter((t) => y2.has(t) && y1.has(t));

// Склейка двух периодов в один непрерывный ряд по часу (без дублей).
const merged = new Map();
for (const t of TOK) {
  const a = y2.get(t), b = y1.get(t);
  const seen = new Set(a.map((r) => r.tsHour));
  merged.set(t, a.concat(b.filter((r) => !seen.has(r.tsHour))).sort((x, y) => x.tsHour - y.tsHour));
}
console.log(`# СКЛЕЙКА`);
for (const t of TOK.slice(0, 3)) { const m = merged.get(t); console.log(`  ${t}: ${m.length} ч, ${m[0].ts.slice(0,13)} .. ${m[m.length-1].ts.slice(0,13)}, дыр по часу ${m.filter((r,i)=>i&&m[i].tsHour-m[i-1].tsHour!==3600).length}`); }

// Мера «сколько края доступно в окне»: движок выбирает конфиг по окну и даёт медиану чистой ставки,
// а также реальный брутто-P&L позиции на $667 за это окно (openPosition/accrueFromRows/positionSummary).
function edge(rows) {
  const sc = M.scanTwoLeg(rows, {});
  if (!sc) return null;
  const b = sc.chosen === "A" ? sc.A : sc.B;
  const t0 = rows[0].tsHour * 1000, t1 = rows[rows.length - 1].tsHour * 1000 + 3600000;
  const p = P.openPosition({ strategy: "two", instrumentKey: "x", config: sc.chosen, capital: 666.67, leverage: 1, nowMs: t0, roundTripCost: 0 });
  P.accrueFromRows(p, rows, t1); P.closePosition(p, t1);
  return { cfg: sc.chosen, med: b.netMedian, mean: b.netMean, gross: P.positionSummary(p).grossPnl, hours: rows.length };
}
const BUCK = 90 * 24; // окно 90 суток

console.log(`\n\n# A. ПРЯМАЯ ПРОВЕРКА МЕХАНИЗМА: край по ВОЗРАСТУ рынка (окна по 90 сут от листинга)`);
console.log(`   значение = медиана чистой ставки лучшего конфига (движок), в скобках брутто $ на $667`);
const hdr = ["0-90","90-180","180-270","270-360","360-450","450-540","540-630","630-720","720-810","810-900","900-990"];
console.log(`| токен | листинг | ${hdr.join(" | ")} |`);
console.log(`|---|---|${hdr.map(()=>"---").join("|")}|`);
const cells = new Map(); // bucketIdx -> [{t, med}]
for (const t of TOK) {
  const m = merged.get(t), ld = Date.parse(L.dateOf(t)) / 1000;
  const out = [];
  for (let k = 0; k < hdr.length; k++) {
    const a = ld + k * BUCK * 3600, b = a + BUCK * 3600;
    const w = m.filter((r) => r.tsHour >= a && r.tsHour < b);
    if (w.length < 24 * 60) { out.push("-"); continue; }   // требуем >=60 суток покрытия
    const e = edge(w);
    out.push(`${(100*e.med).toFixed(0)}% (${e.gross.toFixed(0)})`);
    if (!cells.has(k)) cells.set(k, []); cells.get(k).push({ t, ...e });
  }
  console.log(`| ${t} | ${L.dateOf(t)} | ${out.join(" | ")} |`);
}
console.log(`\n  СВОДКА ПО ВОЗРАСТУ (только те имена, что попали в бакет):`);
console.log(`| возраст, сут | имён | медиана «медианы нетто» | среднее брутто $ | доля имён с нетто>0 |`);
console.log(`|---|---|---|---|---|`);
for (const k of [...cells.keys()].sort((a,b)=>a-b)) {
  const c = cells.get(k), meds = c.map((x) => x.med);
  console.log(`| ${hdr[k]} | ${c.length} | ${(100*M.median(meds)).toFixed(1)}% | ${(c.reduce((s,x)=>s+x.gross,0)/c.length).toFixed(2)} | ${(100*M.fractionPositive(meds)).toFixed(0)}% |`);
}

console.log(`\n\n# B. ПАРНЫЙ ТЕСТ ВНУТРИ ИМЕНИ: первые 90 сут против следующих 90 (и далее)`);
console.log(`| токен | 0-90 | 90-180 | падение? | 180-270 | 270-360 |`);
console.log(`|---|---|---|---|---|---|`);
let down = 0, tot = 0, downG = 0;
for (const t of TOK) {
  const c = [0,1,2,3].map((k) => (cells.get(k)||[]).find((x)=>x.t===t));
  if (!c[0] || !c[1]) continue;
  tot++; const d = c[1].med < c[0].med; if (d) down++;
  if (c[1].gross < c[0].gross) downG++;
  console.log(`| ${t} | ${(100*c[0].med).toFixed(1)}% | ${(100*c[1].med).toFixed(1)}% | ${d?"ДА":"нет"} | ${c[2]?(100*c[2].med).toFixed(1)+"%":"-"} | ${c[3]?(100*c[3].med).toFixed(1)+"%":"-"} |`);
}
console.log(`  имён с полными двумя первыми окнами: ${tot}; медиана УПАЛА у ${down} (${(100*down/tot).toFixed(0)}%), брутто упало у ${downG} (${(100*downG/tot).toFixed(0)}%)`);
console.log(`  знаковый тест: при чистой случайности ожидалось бы 50%. Убывание с возрастом требует СИЛЬНО больше 50%.`);
