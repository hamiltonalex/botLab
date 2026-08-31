// pf-5-whereorwhen.mjs - ЧТО ИМЕННО ЦЕННО: УХОД ИЛИ ВЫБОР ЦЕЛИ. READ-ONLY.
//
// ПАРАДОКС, КОТОРЫЙ ЭТОТ ЗАМЕР РАЗРЕШАЕТ. Замер правила выхода показал, что у ветки перекладки
// НЕТ измеримого края: окупаемость перекладок 44%, это монетка. Замер портфеля показал, что
// возможность УЙТИ стоит $248 при одной позиции и $434 в портфеле. Оба верны, и вместе они
// выглядят противоречием: как уход может быть ценен, если цель выбирается монеткой.
//
// РАЗРЕШЕНИЕ ПРОВЕРЯЕТСЯ ПРЯМО. Разделяем «КОГДА уходить» и «КУДА уходить»: критерий оставляем
// тот же, а место назначения выбираем СЛУЧАЙНО среди годных рынков. Если случайная рука даёт
// почти то же нетто, ценность добывается уходом, и противоречия нет. Если заметно хуже, значит
// выбор цели всё-таки работает, и вывод «края нет» надо пересматривать.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H } from "./pf-lib.mjs";
const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const scan = loadScan(argOf("--scan"));
const env = makeEnv();
const STARTS = Number(argOf("--starts", 60)), STEP = Number(argOf("--step", 12)), SEEDS = Number(argOf("--seeds", 5));
const YEAR = env.YEAR, LEN = YEAR - (H + (STARTS - 1) * STEP);
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const mean = (a) => a.reduce((u, v) => u + v, 0) / a.length;

console.log(`## Уход или выбор цели: ${STARTS} стартов, ${SEEDS} семян у случайной руки, длина ${LEN} ч\n`);
const hold = [], rule = [], rnd = [];
for (let s = 0; s < STARTS; s += 1) {
  const first = H + s * STEP, last = first + LEN;
  hold.push(walk({ scan, env, capital: 5000, cadence: 24, mode: "hold-1", first, last }).net);
  rule.push(walk({ scan, env, capital: 5000, cadence: 24, mode: "rule-1", first, last }).net);
  // По каждому старту усредняем по семенам: одна случайная траектория ничего не говорит.
  const per = [];
  for (let k = 0; k < SEEDS; k += 1) per.push(walk({ scan, env, capital: 5000, cadence: 24, mode: "rule-1", first, last, randomTarget: true, seed: 1 + s * 97 + k * 7919 }).net);
  rnd.push(mean(per));
}
console.log(`| рука | медиана | среднее | мин | макс |`);
console.log(`|---|---|---|---|---|`);
const row = (n, v) => console.log(`| ${n} | $${q(v, 0.5).toFixed(2)} | **$${mean(v).toFixed(2)}** | $${Math.min(...v).toFixed(2)} | $${Math.max(...v).toFixed(2)} |`);
row("hold-1 (не уходим вовсе)", hold);
row("rule-1-СЛУЧАЙНАЯ цель", rnd);
row("rule-1 (цель = argmax)", rule);

console.log(`\n### Разложение ценности правила\n`);
const vLeave = mean(rnd) - mean(hold), vPick = mean(rule) - mean(rnd), vAll = mean(rule) - mean(hold);
console.log(`  ВСЯ ценность правила над базой:            +$${vAll.toFixed(2)}`);
console.log(`  из неё за САМ УХОД (случайная цель):       +$${vLeave.toFixed(2)}  (${(100 * vLeave / vAll).toFixed(0)}%)`);
console.log(`  из неё за ВЫБОР ЦЕЛИ (argmax над случаем): +$${vPick.toFixed(2)}  (${(100 * vPick / vAll).toFixed(0)}%)`);

console.log(`\n### Парно, по стартам\n`);
const pair = (n, a, b) => { const d = a.map((x, i) => x - b[i]); console.log(`  ${n}: выигрывает ${d.filter((x) => x > 0).length} из ${STARTS}, медиана $${q(d, 0.5).toFixed(2)}, среднее $${mean(d).toFixed(2)}`); };
pair("случайная цель против базы  ", rnd, hold);
pair("argmax против случайной цели", rule, rnd);
