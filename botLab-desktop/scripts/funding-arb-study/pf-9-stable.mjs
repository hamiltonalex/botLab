// pf-9-stable.mjs - УСТОЙЧИВОСТЬ ЧИСЛА К НАБОРУ СТАРТОВ. READ-ONLY.
//
// ЗАЧЕМ. В этом годе у руки «держим один рынок» ВСЕГО ТРИ различных исхода (APT, SHIB, TIA),
// поэтому любая статистика по стартам это статистика ТРЁХТОЧЕЧНОЙ СМЕСИ, а медиана сообщает
// пропорцию смеси, а не типичный исход. Два моих замера разошлись ровно на этом: при 40 стартах
// вышло 20 на 20, при 60 стартах APT в большинстве, и парная медиана перевернула знак.
// Здесь число проверяется на УСТОЙЧИВОСТЬ: одна и та же величина считается на четырёх разных
// наборах стартов. Устойчивая величина годится для решения, неустойчивая нет.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H } from "./pf-lib.mjs";
const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const scan = loadScan(argOf("--scan"));
const env = makeEnv();
const YEAR = env.YEAR;
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const mean = (a) => a.reduce((u, v) => u + v, 0) / a.length;
const SETS = [[30, 24], [40, 12], [60, 12], [80, 8]];
const CAPS = [750, 1000, 1500, 2000, 3000, 5000];

console.log(`# Устойчивость к набору стартов, каданс 24 ч\n`);
for (const mode of ["hold-1", "rule-1"]) {
  console.log(`\n## ${mode}: медиана НЕТТО (годовая), четыре набора стартов\n`);
  console.log(`| депозит | 30 стартов | 40 стартов | 60 стартов | 80 стартов | РАЗМАХ | размах, % |`);
  console.log(`|---|---|---|---|---|---|---|`);
  for (const c of CAPS) {
    const vals = [];
    for (const [N, STEP] of SETS) {
      const LEN = YEAR - (H + (N - 1) * STEP), ANN = 8760 / LEN;
      const v = [];
      for (let s = 0; s < N; s += 1) { const first = H + s * STEP; v.push(walk({ scan, env, capital: c, cadence: 24, mode, first, last: first + LEN }).net * ANN); }
      vals.push(q(v, 0.5));
    }
    const sp = Math.max(...vals) - Math.min(...vals);
    console.log(`| $${c} | $${vals.map((x) => x.toFixed(0)).join(" | $")} | **$${sp.toFixed(0)}** | ${(100 * sp / mean(vals)).toFixed(0)}% |`);
  }
}

// ── ПОИМЁННЫЙ РАЗБОР. Это самая устойчивая форма ответа: не «медиана по стартам», а «что даёт
// правило, когда база попала в такой-то рынок». Пропорция смеси сюда не входит вовсе.
console.log(`\n## Поимённо: что даёт правило там, где база попала в конкретный рынок\n`);
const N = 80, STEP = 8, LEN = YEAR - (H + (N - 1) * STEP), ANN = 8760 / LEN;
for (const c of [1000, 5000]) {
  const by = new Map();
  for (let s = 0; s < N; s += 1) {
    const first = H + s * STEP, last = first + LEN;
    const rh = walk({ scan, env, capital: c, cadence: 24, mode: "hold-1", first, last });
    const rr = walk({ scan, env, capital: c, cadence: 24, mode: "rule-1", first, last });
    const tok = ((rh.log.find((e) => e.act === "set") || {}).tokens) || "н-д";
    if (!by.has(tok)) by.set(tok, []);
    by.get(tok).push([rh.net * ANN, rr.net * ANN]);
  }
  console.log(`\nДепозит $${c}, ${N} стартов:\n`);
  console.log(`| рынок базы | стартов | база, год | ПРАВИЛО, год | разность |`);
  console.log(`|---|---|---|---|---|`);
  for (const [tok, v] of [...by].sort((a, b) => b[1].length - a[1].length)) {
    const hh = v.map((x) => x[0]), rr2 = v.map((x) => x[1]);
    console.log(`| ${tok} | ${v.length} | $${mean(hh).toFixed(0)} | **$${mean(rr2).toFixed(0)}** | ${mean(rr2) - mean(hh) >= 0 ? "+" : ""}$${(mean(rr2) - mean(hh)).toFixed(0)} |`);
  }
}
