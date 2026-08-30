import { all } from "./skept-cap-lib.mjs";
const CAP = 1e-7;
// Если аномалия это «маленькая сторона получает то, что платит большая», то в аномальный час
// ОДНА сторона огромна, а ВТОРАЯ обязана оставаться в пределах нормы. Проверяем прямо по кэшу.
let n = 0, payerMax = 0, bothWild = 0, ratios = [];
let worst = null;
for (const [t, rows] of all) {
  if (rows.length !== 8761) continue;
  for (const r of rows) {
    const a = Math.abs(r.f_long), b = Math.abs(r.f_short);
    const hi = Math.max(a, b), lo = Math.min(a, b);
    if (hi <= CAP) continue;
    n++;
    if (lo > CAP) bothWild++;
    if (lo > payerMax) payerMax = lo;
    if (lo > 0) ratios.push(hi / lo);
    if (!worst || hi > worst.hi) worst = { t, ts: r.ts, hi, lo };
  }
}
ratios.sort((x, y) => x - y);
const q = (p) => ratios[Math.floor(p * (ratios.length - 1))];
console.log(`Аномальных часов (одна сторона выше ${CAP}/с): ${n}`);
console.log(`Часов, где ОБЕ стороны аномальны: ${bothWild}  <-- если ноль, утверждение верно`);
console.log(`Максимум МЕНЬШЕЙ стороны за весь год по всем рынкам: ${payerMax.toExponential(4)}/с = ${(100*payerMax*3600*8760).toFixed(1)}% годовых`);
console.log(`  (то есть плательщик ограничен, а аномальна только принимающая сторона)`);
console.log(`\nОтношение большая/меньшая сторона в аномальные часы:`);
console.log(`  медиана ${q(0.5).toFixed(1)}x | 90-й процентиль ${q(0.9).toFixed(0)}x | максимум ${ratios[ratios.length-1].toFixed(0)}x`);
console.log(`\nХудший час: ${worst.t} ${worst.ts}`);
console.log(`  получатель ${(100*worst.hi*3600*8760).toLocaleString("ru-RU",{maximumFractionDigits:0})}% годовых`);
console.log(`  плательщик ${(100*worst.lo*3600*8760).toFixed(1)}% годовых, отношение ${(worst.hi/worst.lo).toFixed(0)}x`);
console.log(`\nСМЫСЛ: ставка получателя высока ИМЕННО ПОТОМУ, что принимающая сторона мала.`);
console.log(`Войдя туда деньгами, ты становишься этой стороной, отношение схлопывается, ставка с ним.`);
