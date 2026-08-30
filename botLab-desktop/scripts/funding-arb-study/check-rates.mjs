import { all, annualizeRow } from "./skept-cap-lib.mjs";
// GMX хранит fundingFactorPerSecond; годовая ставка = factor * 3600 * 8760.
// Протокольный потолок maxFundingFactorPerSecond у рынков GMX V2 порядка 1e-8..1e-7 в секунду,
// что даёт максимум примерно 315%..3150% годовых. Всё, что выше, физически платить нечем.
const CAP_SEC = 1e-7, CAP_APR = CAP_SEC * 3600 * 8760;
console.log(`Протокольный потолок ~${CAP_SEC.toExponential(0)}/с = ${(100*CAP_APR).toFixed(0)}% годовых\n`);
let worst = { apr: 0 }, hoursAbove = 0, total = 0, tokensAbove = new Set();
const runs = new Map();
for (const [t, rows] of all) {
  if (rows.length !== 8761) continue;
  let prev = null, run = 0;
  for (const r of rows) {
    total++;
    const mx = Math.max(Math.abs(r.f_long), Math.abs(r.f_short));
    const apr = mx * 3600 * 8760;
    if (apr > CAP_APR) { hoursAbove++; tokensAbove.add(t); }
    if (apr > worst.apr) worst = { apr, t, ts: r.ts, f: mx };
    // залипший множитель: подряд идущие одинаковые значения при аномальной величине
    if (apr > CAP_APR && r.f_long === prev) { run++; if (run > (runs.get(t) ?? 0)) runs.set(t, run); } else run = apr > CAP_APR ? 1 : 0;
    prev = r.f_long;
  }
}
console.log(`Часов выше потолка: ${hoursAbove} из ${total} = ${(100*hoursAbove/total).toFixed(2)}%`);
console.log(`Затронуто имён: ${tokensAbove.size}`);
console.log(`Худший час: ${worst.t} ${worst.ts}, фактор ${worst.f.toExponential(3)}/с = ${(100*worst.apr).toLocaleString('ru-RU',{maximumFractionDigits:0})}% годовых`);
console.log(`  превышение потолка в ${(worst.apr/CAP_APR).toExponential(2)} раз`);
const stuck = [...runs.entries()].filter(([, n]) => n >= 3).sort((a,b)=>b[1]-a[1]);
console.log(`\nИмён с ПОДРЯД идущими одинаковыми аномальными значениями (признак залипшего множителя): ${stuck.length}`);
for (const [t, n] of stuck.slice(0, 8)) console.log(`  ${t}: серия из ${n} одинаковых часов`);
