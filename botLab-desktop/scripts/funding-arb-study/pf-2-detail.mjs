// pf-2-detail.mjs - ПОСТАРТОВЫЙ РАЗБОР И НЕЗАВИСИМЫЙ ПЕРЕСЧЁТ. READ-ONLY.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H } from "./pf-lib.mjs";
const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const scan = loadScan(argOf("--scan"));
const env = makeEnv();
const YEAR = env.YEAR, STARTS = 12, STEP = 60, LEN = YEAR - (H + (STARTS - 1) * STEP);

console.log(`## Постартовый разбор, режим equal, длина ${LEN} ч, капитал $5000\n`);
console.log(`| старт | hold-1 нетто | рынок | hold-pf нетто | состав | rule-1 | rule-pf |`);
console.log(`|---|---|---|---|---|---|---|`);
const cols = { "hold-1": [], "hold-pf": [], "rule-1": [], "rule-pf": [] };
for (let s = 0; s < STARTS; s += 1) {
  const first = H + s * STEP, last = first + LEN;
  const r = {};
  for (const m of Object.keys(cols)) { r[m] = walk({ scan, env, capital: 5000, cadence: 24, mode: m, first, last }); cols[m].push(r[m].net); }
  const tok1 = (r["hold-1"].log.find((e) => e.act === "set") || {}).tokens || "н-д";
  const tokP = (r["hold-pf"].log.find((e) => e.act === "set") || {}).tokens || "н-д";
  console.log(`| ${s} (час ${first}) | $${r["hold-1"].net.toFixed(2)} | ${tok1} | $${r["hold-pf"].net.toFixed(2)} | ${tokP} | $${r["rule-1"].net.toFixed(2)} | $${r["rule-pf"].net.toFixed(2)} |`);
}
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
console.log(`\n| рука | медиана | мин | макс | среднее |`);
console.log(`|---|---|---|---|---|`);
for (const [m, v] of Object.entries(cols)) {
  console.log(`| ${m} | $${q(v, 0.5).toFixed(2)} | $${Math.min(...v).toFixed(2)} | $${Math.max(...v).toFixed(2)} | $${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)} |`);
}

// ── НЕЗАВИСИМЫЙ ПЕРЕСЧЁТ ОДНОГО ПРОГОНА. Ходок начисляет ОТРЕЗКАМИ между точками решения. Если
// сумма отрезков не равна одному длинному начислению, начисление зависит от разбивки, и все числа
// выше надо выбросить. Проверяется на руке hold-pf, где позиций много и разбивок больше всего.
console.log(`\n## Независимый пересчёт: сумма отрезков против одного длинного начисления\n`);
const first = H, last = first + LEN;
const r = walk({ scan, env, capital: 5000, cadence: 24, mode: "hold-pf", first, last });
const set = r.log.find((e) => e.act === "set");
const tgtHour = scan.get(set.t);
let direct = 0, costs = 0;
const parts = [];
for (const token of set.tokens.split("+")) {
  const c = tgtHour.find((x) => x.k === token);
  // размер берётся из журнала установки, а не из кривой: распределитель мог дать меньше оптимума
  const size = r.log[0].usd && null;
  parts.push(token);
}
// размеры восстанавливаются повторным вызовом того же распределителя
import("../../src/engine/fa/sizing.js").then(({ allocateCapital, costAtSize, FA_SIZING_DEFAULTS }) => {
  const arms = tgtHour.map((c) => ({ token: c.k, config: c.c, hull: c.h.map(([sizeUsd, net]) => ({ sizeUsd, net })), netUsd: c.n }));
  const { alloc } = allocateCapital(arms, 5000, FA_SIZING_DEFAULTS);
  const cfgOf = new Map(arms.map((a) => [a.token, a.config]));
  for (const [token, size] of alloc) {
    const cfg = cfgOf.get(token);
    const g = env.grossOn(token, cfg, size, set.t, last - set.t);
    const c = env.costOn(token, cfg, size);
    direct += g; costs += c;
    console.log(`  ${token}/${cfg} $${size.toFixed(0)}: брутто одним начислением $${g.toFixed(2)}, круг $${c.toFixed(2)}`);
  }
  console.log(`\n  ОДНИМ НАЧИСЛЕНИЕМ: брутто $${direct.toFixed(2)} минус издержки $${costs.toFixed(2)} = нетто $${(direct - costs).toFixed(2)}`);
  console.log(`  ХОДОК ОТРЕЗКАМИ:   брутто $${r.realized.toFixed(2)} минус издержки $${r.costs.toFixed(2)} = нетто $${r.net.toFixed(2)}`);
  const d = Math.abs((direct - costs) - r.net);
  console.log(`  РАСХОЖДЕНИЕ $${d.toFixed(4)} ${d < 0.01 ? "-> начисление от разбивки НЕ зависит" : "-> НАЧИСЛЕНИЕ ЗАВИСИТ ОТ РАЗБИВКИ, числа выше недействительны"}`);
});
