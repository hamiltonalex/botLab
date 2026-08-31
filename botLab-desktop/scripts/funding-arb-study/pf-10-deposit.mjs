// pf-10-deposit.mjs - ТАБЛИЦА В ТЕРМИНАХ РЕАЛЬНОГО ДЕПОЗИТА, А НЕ НОЦИОНАЛА. READ-ONLY.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Все предыдущие таблицы индексированы НОЦИОНАЛОМ (размер позиции на
// каждой ноге), и проценты в них считались от него. Владельцу нужны проценты от ДЕПОЗИТА, то есть
// от денег, которые он реально кладёт на две биржи. Это разные числа, и путать их нельзя:
//   движок начисляет обе ноги на ПОЛНЫЙ ноционал (dPnlGmx на notional и dPnlHl на notional),
//   значит держатся S на GMX и S на Hyperliquid ОДНОВРЕМЕННО;
//   при плече L на каждой ноге депозит = 2*S/L.
// Следствие, которое надо назвать явно: при депозите $5000 и плече 1 ноционал равен $2500,
// а не $5000, и годовой процент от депозита ВДВОЕ ниже процента от ноционала.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H } from "./pf-lib.mjs";
const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const scan = loadScan(argOf("--scan"));
const env = makeEnv();
const STARTS = 40, STEP = 12, YEAR = env.YEAR;
const LEN = YEAR - (H + (STARTS - 1) * STEP), ANN = 8760 / LEN;
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };

const NOTIONALS = (argOf("--sizes", "1250,2500") || "").split(",").map(Number);
console.log(`| ноционал на ногу | нетто год (медиана) | худший старт | стартов в плюсе | кругов |`);
console.log(`|---|---|---|---|---|`);
for (const c of NOTIONALS) {
  for (const mode of ["hold-1", "rule-1"]) {
    const v = [], t = [];
    for (let s = 0; s < STARTS; s += 1) { const first = H + s * STEP; const r = walk({ scan, env, capital: c, cadence: 24, mode, first, last: first + LEN }); v.push(r.net * ANN); t.push(r.tally.open); }
    console.log(`| $${c} ${mode} | $${q(v, 0.5).toFixed(2)} | $${Math.min(...v).toFixed(2)} | ${v.filter((x) => x > 0).length}/${STARTS} | ${q(t, 0.5).toFixed(0)} |`);
  }
}
