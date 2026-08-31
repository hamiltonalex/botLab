// pf-13-dd.mjs - ПРОСАДКА И СРОК ДОКАЗАТЕЛЬСТВА. READ-ONLY.
//
// ДВА ВОПРОСА ВЛАДЕЛЬЦА, оба про то, что он увидит на счёте, а не про итог года.
//   ПРОСАДКА: если посмотреть на счёт в худший момент, какую цифру он покажет.
//   СРОК: через сколько прогон становится НАДЁЖНО положительным. Пробный депозит должен доказать
//     механизм, а прогон, который каждый третий месяц уходит в минус, ничего не доказывает.
// Считается по кривой накопленного НЕТТО (издержки уже вычтены), то есть по тому же числу,
// которое владелец увидел бы на счёте.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H } from "./pf-lib.mjs";
const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const scan = loadScan(argOf("--scan"));
const env = makeEnv();
const STARTS = 40, STEP = 12, YEAR = env.YEAR, NOTIONAL = Number(argOf("--size", 2500)), DEPOSIT = 2 * NOTIONAL;
const LEN = YEAR - (H + (STARTS - 1) * STEP);
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };

console.log(`# Просадка и срок. Ноционал $${NOTIONAL} на ногу, депозит $${DEPOSIT} при плече 1.\n`);
console.log(`${STARTS} стартов, длина ${LEN} ч (${(LEN / 24).toFixed(0)} сут), каданс 24 ч.\n`);

const runs = {};
for (const mode of ["rule-1", "hold-1"]) {
  runs[mode] = [];
  for (let s = 0; s < STARTS; s += 1) { const first = H + s * STEP; runs[mode].push(walk({ scan, env, capital: NOTIONAL, cadence: 24, mode, first, last: first + LEN })); }
}

console.log(`## Просадка накопленного нетто\n`);
console.log(`| рука | просадка медиана | ХУДШАЯ | % от депозита | % от годовой прибыли | день худшей |`);
console.log(`|---|---|---|---|---|---|`);
for (const mode of ["rule-1", "hold-1"]) {
  const dds = [], days = [];
  for (const r of runs[mode]) {
    let peak = -Infinity, dd = 0, at = 0;
    for (const [t, c] of r.curve) { if (c > peak) peak = c; if (c - peak < dd) { dd = c - peak; at = (t - r.first) / 24; } }
    dds.push(-dd); days.push(at);
  }
  const worst = Math.max(...dds);
  const yr = q(runs[mode].map((r) => r.net), 0.5) * (8760 / LEN);
  console.log(`| ${mode} | $${q(dds, 0.5).toFixed(2)} | **$${worst.toFixed(2)}** | ${(100 * worst / DEPOSIT).toFixed(2)}% | ${(100 * worst / yr).toFixed(0)}% | ${q(days, 0.5).toFixed(0)} сут |`);
}

console.log(`\n## Срок доказательства: скользящие окна по кривой одного длинного прогона\n`);
// Один прогон с самого начала года, окна по кривой: это ровно то, что владелец увидит, запустив
// бота один раз и глядя на счёт через N суток после произвольного момента.
const long = walk({ scan, env, capital: NOTIONAL, cadence: 24, mode: "rule-1", first: H, last: YEAR });
console.log(`| окно | окон | доля В ПЛЮСЕ | медиана нетто | 10-й процентиль | худшее окно |`);
console.log(`|---|---|---|---|---|---|`);
for (const days of [14, 30, 60, 90, 180]) {
  const step = Math.round(days * 24 / 24); // кривая с шагом каданса 24 ч, значит индекс = сутки
  const v = [];
  for (let i = 0; i + step < long.curve.length; i += 1) v.push(long.curve[i + step][1] - long.curve[i][1]);
  if (!v.length) continue;
  console.log(`| ${days} сут | ${v.length} | **${(100 * v.filter((x) => x > 0).length / v.length).toFixed(1)}%** | $${q(v, 0.5).toFixed(2)} | $${q(v, 0.1).toFixed(2)} | $${Math.min(...v).toFixed(2)} |`);
}
