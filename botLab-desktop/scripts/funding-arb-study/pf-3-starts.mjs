// pf-3-starts.mjs - РАЗБОР ПО МНОГИМ СТАРТАМ. READ-ONLY.
//
// ЗАЧЕМ. При 12 стартах со сдвигом 60 ч рука hold-1 попала ВСЕГО В ДВА рынка: SHIB на пяти стартах
// и APT на семи. Значит её медиана это не статистика, а то, какая из двух монет выпала чаще, и
// сравнивать с ней правило нельзя, пока не выяснено, сколько РАЗЛИЧНЫХ исходов у неё вообще есть.
// Здесь стартов больше и шаг меньше, чтобы вопрос закрылся числом.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H } from "./pf-lib.mjs";
const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const scan = loadScan(argOf("--scan"));
const env = makeEnv();
const STARTS = Number(argOf("--starts", 60)), STEP = Number(argOf("--step", 12));
const YEAR = env.YEAR, LEN = YEAR - (H + (STARTS - 1) * STEP);
const MODES = ["hold-1", "hold-pf", "rule-1", "rule-pf"];
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };

const cols = Object.fromEntries(MODES.map((m) => [m, []]));
const firstTok = Object.fromEntries(MODES.map((m) => [m, []]));
for (let s = 0; s < STARTS; s += 1) {
  const first = H + s * STEP, last = first + LEN;
  for (const m of MODES) {
    const r = walk({ scan, env, capital: 5000, cadence: 24, mode: m, first, last });
    cols[m].push(r.net);
    firstTok[m].push(((r.log.find((e) => e.act === "set") || {}).tokens || "н-д"));
  }
}
console.log(`## ${STARTS} стартов со сдвигом ${STEP} ч, длина ${LEN} ч, капитал $5000, каданс 24 ч\n`);
console.log(`| рука | медиана | СРЕДНЕЕ | мин | макс | p10 | p90 | различных стартовых составов |`);
console.log(`|---|---|---|---|---|---|---|---|`);
for (const m of MODES) {
  const v = cols[m], u = new Set(firstTok[m]);
  console.log(`| ${m} | $${q(v, 0.5).toFixed(2)} | **$${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)}** | $${Math.min(...v).toFixed(2)} | $${Math.max(...v).toFixed(2)} | $${q(v, 0.1).toFixed(2)} | $${q(v, 0.9).toFixed(2)} | ${u.size} |`);
}
console.log(`\n### Какие рынки ловит hold-1 и сколько раз\n`);
const cnt = new Map();
for (const t of firstTok["hold-1"]) cnt.set(t, (cnt.get(t) || 0) + 1);
for (const [t, n] of [...cnt].sort((a, b) => b[1] - a[1])) {
  const vals = cols["hold-1"].filter((_, i) => firstTok["hold-1"][i] === t);
  console.log(`  ${String(n).padStart(2)}x  ${t.padEnd(8)} нетто от $${Math.min(...vals).toFixed(0)} до $${Math.max(...vals).toFixed(0)}`);
}
console.log(`\n### Разложение: что даёт деконцентрация, а что возможность УЙТИ\n`);
const mean = (m) => cols[m].reduce((a, b) => a + b, 0) / cols[m].length;
console.log(`| |  одна позиция | портфель | разница = цена деконцентрации |`);
console.log(`|---|---|---|---|`);
console.log(`| держим до конца | $${mean("hold-1").toFixed(2)} | $${mean("hold-pf").toFixed(2)} | ${(mean("hold-pf") - mean("hold-1")).toFixed(2)} |`);
console.log(`| можем уйти | $${mean("rule-1").toFixed(2)} | $${mean("rule-pf").toFixed(2)} | ${(mean("rule-pf") - mean("rule-1")).toFixed(2)} |`);
console.log(`| разница = ЦЕНА ВОЗМОЖНОСТИ УЙТИ | +$${(mean("rule-1") - mean("hold-1")).toFixed(2)} | +$${(mean("rule-pf") - mean("hold-pf")).toFixed(2)} | |`);
