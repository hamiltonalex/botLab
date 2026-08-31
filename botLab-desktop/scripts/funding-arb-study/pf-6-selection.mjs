// pf-6-selection.mjs - ЦЕННОСТЬ ОТБОРА БЕЗ ТРАЕКТОРИИ. READ-ONLY.
//
// ПОЧЕМУ ПРЕДЫДУЩИЙ ЗАМЕР (pf-5) НЕДОСТАТОЧЕН. Там случайная цель гонялась ТРАЕКТОРИЕЙ, и у неё
// два отличия сразу: цель хуже И круги чаще, потому что попав в плохой рынок, критерий срабатывает
// снова на следующем же шаге. Значит минус смешивает качество цели с частотой перекладок, и
// приписать его качеству нельзя. Здесь траектории нет вовсе: в КАЖДОЙ точке решения сравнивается
// брутто ВПЕРЁД у argmax и у случайного годного рынка при одном размере отбора. Издержки не
// участвуют ни в одной ветке, поэтому чурн исключён по построению.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H } from "./pf-lib.mjs";
const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const scan = loadScan(argOf("--scan"));
const env = makeEnv();
const YEAR = env.YEAR;
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const mean = (a) => a.reduce((u, v) => u + v, 0) / a.length;
let seed = 12345; const rand = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };

console.log(`## Сколько кругов платит случайная рука (проверка чурна)\n`);
console.log(`| рука | кругов, медиана | нетто, среднее |`);
console.log(`|---|---|---|`);
for (const [n, o] of [["rule-1 argmax", {}], ["rule-1 случайная цель", { randomTarget: true }]]) {
  const t = [], v = [];
  for (let s = 0; s < 20; s += 1) { const first = H + s * 12, last = first + (YEAR - (H + 59 * 12)); const r = walk({ scan, env, capital: 5000, cadence: 24, mode: "rule-1", first, last, seed: 1 + s * 97, ...o }); t.push(r.tally.open); v.push(r.net); }
  console.log(`| ${n} | ${q(t, 0.5).toFixed(0)} | $${mean(v).toFixed(2)} |`);
}

console.log(`\n## Ценность ОТБОРА без траектории: брутто вперёд argmax против случайного\n`);
const hrs = [...scan.keys()].filter((t) => t % 24 === 0 && t + H <= YEAR).sort((a, b) => a - b);
const dA = [], dR = [], dM = [];
for (const t of hrs) {
  const ok = scan.get(t).filter((c) => c.n > 0);
  if (ok.length < 2) continue;
  const best = ok.reduce((a, b) => (b.n > a.n ? b : a));
  const pick = ok[Math.floor(rand() * ok.length)];
  const gA = env.grossOn(best.k, best.c, best.s, t, H);
  const gR = env.grossOn(pick.k, pick.c, pick.s, t, H);
  // медианный рынок отбора: чтобы отличить «argmax лучше случайного» от «argmax лучше ХУДШИХ»
  const sorted = [...ok].sort((a, b) => b.n - a.n);
  const med = sorted[Math.floor(sorted.length / 2)];
  const gM = env.grossOn(med.k, med.c, med.s, t, H);
  if ([gA, gR, gM].every(Number.isFinite)) { dA.push(gA); dR.push(gR); dM.push(gM); }
}
console.log(`точек решения ${dA.length}, горизонт вперёд ${H} ч, размер = выбор правила входа\n`);
console.log(`| выбор | медиана брутто вперёд | среднее | доля положительных |`);
console.log(`|---|---|---|---|`);
const row = (n, v) => console.log(`| ${n} | $${q(v, 0.5).toFixed(2)} | $${mean(v).toFixed(2)} | ${(100 * v.filter((x) => x > 0).length / v.length).toFixed(1)}% |`);
row("argmax по трейлингу", dA);
row("МЕДИАННЫЙ годный рынок", dM);
row("СЛУЧАЙНЫЙ годный рынок", dR);
const w = dA.map((x, i) => x - dR[i]);
console.log(`\nargmax против случайного, парно по точкам: выигрывает ${(100 * w.filter((x) => x > 0).length / w.length).toFixed(1)}%, медиана разности $${q(w, 0.5).toFixed(2)}, среднее $${mean(w).toFixed(2)}`);
