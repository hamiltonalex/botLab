// pf-4-paired.mjs - ПАРНОЕ СРАВНЕНИЕ РУК. READ-ONLY.
//
// ЗАЧЕМ ПАРНОЕ. Старты ПЕРЕСЕКАЮТСЯ по данным (сдвиг 12 ч при длине 7333 ч), поэтому 60 наблюдений
// это не 60 независимых. Сравнивать распределения при такой зависимости нельзя. А вот РАЗНОСТЬ на
// ОДНОМ старте эффект старта убирает: обе руки видели один и тот же год.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H } from "./pf-lib.mjs";
const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const scan = loadScan(argOf("--scan"));
const env = makeEnv();
const STARTS = Number(argOf("--starts", 60)), STEP = Number(argOf("--step", 12));
const YEAR = env.YEAR, LEN = YEAR - (H + (STARTS - 1) * STEP);
const MODES = ["hold-1", "hold-pf", "rule-1", "rule-pf"];
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };

const res = Object.fromEntries(MODES.map((m) => [m, []]));
const trips = Object.fromEntries(MODES.map((m) => [m, []]));
for (let s = 0; s < STARTS; s += 1) {
  const first = H + s * STEP, last = first + LEN;
  for (const m of MODES) { const r = walk({ scan, env, capital: 5000, cadence: 24, mode: m, first, last }); res[m].push(r.net); trips[m].push(r.tally.open); }
}
console.log(`## Парное сравнение на ${STARTS} стартах (сдвиг ${STEP} ч, длина ${LEN} ч)\n`);
console.log(`| пара A против B | A выигрывает | медиана разности | среднее разности | p10 | p90 |`);
console.log(`|---|---|---|---|---|---|`);
const pair = (a, b) => {
  const d = res[a].map((x, i) => x - res[b][i]);
  const w = d.filter((x) => x > 0).length;
  console.log(`| ${a} против ${b} | ${w} из ${STARTS} | $${q(d, 0.5).toFixed(2)} | $${(d.reduce((u, v) => u + v, 0) / d.length).toFixed(2)} | $${q(d, 0.1).toFixed(2)} | $${q(d, 0.9).toFixed(2)} |`);
};
pair("rule-1", "hold-1");
pair("rule-pf", "hold-pf");
pair("hold-pf", "hold-1");
pair("rule-pf", "rule-1");
console.log(`\n### Кругов оплачено, медиана за прогон\n`);
for (const m of MODES) console.log(`  ${m.padEnd(9)} ${q(trips[m], 0.5).toFixed(0)}`);
console.log(`\n### Цена одного лишнего круга у rule-pf против rule-1\n`);
const dNet = res["rule-pf"].map((x, i) => x - res["rule-1"][i]).reduce((a, b) => a + b, 0) / STARTS;
const dTrip = q(trips["rule-pf"], 0.5) - q(trips["rule-1"], 0.5);
console.log(`  прибавка нетто $${dNet.toFixed(2)} за ${dTrip.toFixed(0)} лишних кругов = $${(dNet / dTrip).toFixed(3)} на круг`);
console.log(`  для сравнения: круг на $1000 стоит около $4.10, то есть прибавка НИЖЕ цены круга в ${(4.1 / (dNet / dTrip)).toFixed(1)} раза`);
