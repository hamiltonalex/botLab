// pf-7-small.mjs - МАЛЫЙ ДЕПОЗИТ: ЧТО ВЫЖИМАЕТСЯ И ЧЕМ ЗА ЭТО ПЛАЧЕНО. READ-ONLY.
//
// ПОСТАНОВКА. Депозит МАЛ по внешней причине: боту не дадут большую маржу, пока он себя не показал.
// Значит задача не «сколько выжать вообще», а «сколько выжать при связанном сверху капитале»,
// и у неё другой ответ, потому что при малом размере меняются ОБА главных члена:
//   ПЛОСКИЙ ДОЛЛАР ГАЗА в круге. Круг = ноционал*0.31% + $1. На $500 плоская часть это 39% круга,
//     на $5000 всего 6%. Значит частые перекладки при малом депозите дороже в относительном
//     выражении, и лучший каданс может уехать в сторону ЗАМЕДЛЕНИЯ.
//   РАЗБАВЛЕНИЕ. Доход = pot*S/(B+S), поэтому при меньшем S ловится БОЛЬШАЯ доля ставки, и
//     процент доходности при малом депозите должен быть ВЫШЕ. Это надо проверить, а не принять.
// Плюс жёсткий пол: minTicketUsd = $500, ниже него позиция не открывается вовсе.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H } from "./pf-lib.mjs";
const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const scan = loadScan(argOf("--scan"));
const env = makeEnv();
const STARTS = Number(argOf("--starts", 40)), STEP = Number(argOf("--step", 12));
const YEAR = env.YEAR, LEN = YEAR - (H + (STARTS - 1) * STEP);
const ANN = 8760 / LEN;
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const mean = (a) => a.reduce((u, v) => u + v, 0) / a.length;

const CAPS = [400, 500, 750, 1000, 1500, 2000, 3000, 5000];
const CADS = [24, 168, 720];

function run(capital, mode, cadence) {
  const net = [], gross = [], cost = [], trips = [];
  for (let s = 0; s < STARTS; s += 1) {
    const first = H + s * STEP;
    const r = walk({ scan, env, capital, cadence, mode, first, last: first + LEN });
    net.push(r.net); gross.push(r.realized); cost.push(r.costs); trips.push(r.tally.open);
  }
  return { net, gross, cost, trips };
}

console.log(`# Малый депозит: максимум прибыли при связанном капитале\n`);
console.log(`${STARTS} стартов со сдвигом ${STEP} ч, длина ${LEN} ч, годовой множитель ${ANN.toFixed(3)}.`);
console.log(`Минимальный тикет $500, потолок тикета $5000, вселенная 63 рынка.\n`);

console.log(`## Держим один рынок (перекладок нет, круг один за год)\n`);
console.log(`| депозит | нетто год | % годовых | пол (мин) | стартов в плюсе | издержки, % брутто |`);
console.log(`|---|---|---|---|---|---|`);
const holdRows = {};
for (const c of CAPS) {
  const r = run(c, "hold-1", 720);
  const y = q(r.net, 0.5) * ANN;
  holdRows[c] = y;
  console.log(`| $${c} | $${y.toFixed(2)} | **${(100 * y / c).toFixed(2)}%** | $${(Math.min(...r.net) * ANN).toFixed(2)} | ${r.net.filter((x) => x > 0).length}/${STARTS} | ${(100 * q(r.cost, 0.5) / q(r.gross, 0.5)).toFixed(1)}% |`);
}

for (const cad of CADS) {
  console.log(`\n## Правило выхода, одна позиция, каданс ${cad} ч\n`);
  console.log(`| депозит | нетто год | % годовых | пол (мин) | стартов в плюсе | кругов | издержки, % брутто | против «держим» |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  for (const c of CAPS) {
    const r = run(c, "rule-1", cad);
    const y = q(r.net, 0.5) * ANN;
    const g = q(r.gross, 0.5);
    console.log(`| $${c} | $${y.toFixed(2)} | **${(100 * y / c).toFixed(2)}%** | $${(Math.min(...r.net) * ANN).toFixed(2)} | ${r.net.filter((x) => x > 0).length}/${STARTS} | ${q(r.trips, 0.5).toFixed(0)} | ${g > 0 ? (100 * q(r.cost, 0.5) / g).toFixed(1) : "н-д"}% | ${(y - holdRows[c] >= 0 ? "+" : "")}$${(y - holdRows[c]).toFixed(2)} |`);
  }
}
