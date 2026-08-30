// Б1. Механизм ставки HL: связь hl_rate <- hl_premium по данным кэша.
import { all, SP } from "./skept-cap-lib.mjs";
import fs from "node:fs";

const toks = [...all.keys()].sort();
let N = 0, nanR = 0, nanP = 0;
const P = [], R = [];
for (const t of toks) for (const r of all.get(t)) {
  N++;
  if (!Number.isFinite(r.hl_rate)) { nanR++; continue; }
  if (!Number.isFinite(r.hl_premium)) { nanP++; continue; }
  P.push(r.hl_premium); R.push(r.hl_rate);
}
console.log(`токенов ${toks.length}, строк ${N}, hl_rate NaN ${nanR}, hl_premium NaN ${nanP}, пар ${P.length}`);

const mn=(a)=>a.reduce((x,y)=>y<x?y:x,Infinity), mx_=(a)=>a.reduce((x,y)=>y>x?y:x,-Infinity);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
console.log("\nhl_rate:    min", mn(R), "max", mx_(R), "p01", q(R,.01), "медиана", q(R,.5), "p99", q(R,.99));
console.log("hl_premium: min", mn(P), "max", mx_(P), "p01", q(P,.01), "медиана", q(P,.5), "p99", q(P,.99));

// Гипотеза: F = P + clamp(I - P, -c, +c)  (форма Binance/HL)
// внутри полосы F = I (константа), вне полосы F = P -/+ c
const model = (p, I, c) => p + Math.max(-c, Math.min(c, I - p));
function score(I, c) {
  let sae = 0, mx = 0, exact = 0;
  for (let i = 0; i < P.length; i++) {
    const e = Math.abs(R[i] - model(P[i], I, c));
    sae += e; if (e > mx) mx = e; if (e <= 1e-12) exact++;
  }
  return { mae: sae / P.length, mx, exactFrac: exact / P.length };
}

// I читается прямо: строки, где |I-P| заведомо внутри полосы, дают F = I ровно.
const modeR = (() => { const m = new Map(); for (const v of R) m.set(v, (m.get(v) || 0) + 1); return [...m].sort((a,b)=>b[1]-a[1]).slice(0,5); })();
console.log("\nсамые частые значения hl_rate (значение, сколько часов):");
for (const [v, n] of modeR) console.log("   ", v, n, (100*n/R.length).toFixed(2) + "%");

const I0 = modeR[0][0];
// c подбираем по сетке
let best = null;
for (const c of [1e-4, 2e-4, 3e-4, 4e-4, 4.5e-4, 5e-4, 5.5e-4, 6e-4, 1e-3, 5e-3]) {
  const s = score(I0, c);
  console.log(`c=${c}  MAE=${s.mae.toExponential(3)}  maxErr=${s.mx.toExponential(3)}  точных=${(100*s.exactFrac).toFixed(3)}%`);
  if (!best || s.mae < best.s.mae) best = { c, s };
}
console.log(`\nЛУЧШЕЕ: I=${I0}  c=${best.c}  MAE=${best.s.mae.toExponential(3)}  max|err|=${best.s.mx.toExponential(3)}  точных совпадений ${(100*best.s.exactFrac).toFixed(3)}%`);

// уточняем c ньютоновским сужением
let lo = 1e-4, hi = 2e-3;
for (let k = 0; k < 60; k++) {
  const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
  if (score(I0, a).mae < score(I0, b).mae) hi = b; else lo = a;
}
const cFit = (lo + hi) / 2;
console.log(`c уточнённое = ${cFit.toExponential(6)}  MAE=${score(I0, cFit).mae.toExponential(3)}`);

// Режимы: доля часов внутри полосы (dF/dP = 0) и вне (dF/dP = 1)
const c = best.c, I = I0;
let inBand = 0, above = 0, below = 0;
for (let i = 0; i < P.length; i++) {
  const d = I - P[i];
  if (d > c) below++; else if (d < -c) above++; else inBand++;
}
console.log(`\nРЕЖИМЫ (I=${I}, c=${c}):`);
console.log(`  внутри полосы  F=I, dF/dP=0 : ${inBand} ч = ${(100*inBand/P.length).toFixed(2)}%`);
console.log(`  премия выше    F=P-c, dF/dP=1: ${above} ч = ${(100*above/P.length).toFixed(2)}%`);
console.log(`  премия ниже    F=P+c, dF/dP=1: ${below} ч = ${(100*below/P.length).toFixed(2)}%`);

// Остаток, не объяснённый премией = процентная составляющая. Постоянна ли?
const resid = [];
for (let i = 0; i < P.length; i++) resid.push(R[i] - P[i]);
console.log(`\nостаток hl_rate - hl_premium: min ${mn(resid).toExponential(3)} max ${mx_(resid).toExponential(3)}`);
console.log(`  p01 ${q(resid,.01).toExponential(3)}  медиана ${q(resid,.5).toExponential(3)}  p99 ${q(resid,.99).toExponential(3)}`);
console.log(`  доля |остатка| == c ровно: ${(100*resid.filter(x=>Math.abs(Math.abs(x)-c)<1e-12).length/resid.length).toFixed(2)}%`);

// Проверка потолка ставки (HL декларирует 4%/час)
const capHits = R.filter((x) => Math.abs(x) >= 0.039).length;
console.log(`\n|hl_rate| >= 3.9%/ч: ${capHits} часов; max|rate| = ${mx_(R.map(Math.abs)).toExponential(4)}`);

// Разбивка ошибок по токенам: где модель не держит
const bad = [];
for (const t of toks) {
  let mx = 0, n = 0, sae = 0;
  for (const r of all.get(t)) {
    if (!Number.isFinite(r.hl_rate) || !Number.isFinite(r.hl_premium)) continue;
    const e = Math.abs(r.hl_rate - model(r.hl_premium, I, c)); sae += e; n++; if (e > mx) mx = e;
  }
  if (n) bad.push({ t, n, mae: sae / n, mx });
}
bad.sort((a, b) => b.mae - a.mae);
console.log("\nхуже всего описаны моделью (токен, часов, MAE, max|err|):");
for (const b of bad.slice(0, 12)) console.log(`   ${b.t.padEnd(9)} ${b.n} ${b.mae.toExponential(3)} ${b.mx.toExponential(3)}`);
console.log("лучше всего:");
for (const b of bad.slice(-3)) console.log(`   ${b.t.padEnd(9)} ${b.n} ${b.mae.toExponential(3)} ${b.mx.toExponential(3)}`);

fs.writeFileSync(`${SP}/hlc-b-mech.json`, JSON.stringify({ I, c, cFit, inBand: inBand/P.length, above: above/P.length, below: below/P.length, n: P.length }, null, 1));
