// pf-8-why.mjs - ПОЧЕМУ ДВА МОИХ ЗАМЕРА РАСХОДЯТСЯ. READ-ONLY.
// pf-3 (60 стартов, длина 7333) дал при $5000: hold-1 $1202, rule-1 $998.
// pf-7 (40 стартов, длина 7573) дал при $5000: hold-1 $778 сырых, rule-1 $992 сырых.
// Знак разности перевернулся. Пока не выяснено, ни одну таблицу подавать нельзя.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H } from "./pf-lib.mjs";
const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const scan = loadScan(argOf("--scan"));
const env = makeEnv();
const YEAR = env.YEAR;
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const mean = (a) => a.reduce((u, v) => u + v, 0) / a.length;

for (const [STARTS, STEP] of [[40, 12], [60, 12]]) {
  const LEN = YEAR - (H + (STARTS - 1) * STEP);
  console.log(`\n## ${STARTS} стартов, шаг ${STEP} ч, длина ${LEN} ч, старты с ${H} по ${H + (STARTS - 1) * STEP}\n`);
  const h = [], r = [], tok = [];
  for (let s = 0; s < STARTS; s += 1) {
    const first = H + s * STEP, last = first + LEN;
    const rh = walk({ scan, env, capital: 5000, cadence: 24, mode: "hold-1", first, last });
    h.push(rh.net); r.push(walk({ scan, env, capital: 5000, cadence: 24, mode: "rule-1", first, last }).net);
    tok.push(((rh.log.find((e) => e.act === "set") || {}).tokens) || "н-д");
  }
  const d = r.map((x, i) => x - h[i]);
  console.log(`hold-1: медиана $${q(h, 0.5).toFixed(2)}, среднее $${mean(h).toFixed(2)}`);
  console.log(`rule-1: медиана $${q(r, 0.5).toFixed(2)}, среднее $${mean(r).toFixed(2)}`);
  console.log(`ПАРНО правило минус держим: выигрывает ${d.filter((x) => x > 0).length} из ${STARTS}, медиана $${q(d, 0.5).toFixed(2)}, среднее $${mean(d).toFixed(2)}`);
  const cnt = new Map();
  for (const t of tok) cnt.set(t, (cnt.get(t) || 0) + 1);
  console.log(`рынки hold-1: ${[...cnt].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n}x ${t}`).join(", ")}`);
}

// РАЗДЕЛЯЕМ ДВА ОТЛИЧИЯ: набор стартов и ДЛИНА. Гоняем ОДИН набор стартов при ОБЕИХ длинах.
console.log(`\n## Тот же набор из 40 стартов, но обе длины\n`);
for (const LEN of [7573, 7333]) {
  const h = [], r = [];
  for (let s = 0; s < 40; s += 1) {
    const first = H + s * 12, last = first + LEN;
    h.push(walk({ scan, env, capital: 5000, cadence: 24, mode: "hold-1", first, last }).net);
    r.push(walk({ scan, env, capital: 5000, cadence: 24, mode: "rule-1", first, last }).net);
  }
  const d = r.map((x, i) => x - h[i]);
  console.log(`длина ${LEN} ч: hold-1 медиана $${q(h, 0.5).toFixed(2)}, rule-1 медиана $${q(r, 0.5).toFixed(2)}, правило выигрывает ${d.filter((x) => x > 0).length}/40, медиана разности $${q(d, 0.5).toFixed(2)}`);
}
