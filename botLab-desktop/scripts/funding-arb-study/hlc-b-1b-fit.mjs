// Б1 (уточнение). Форма: hl_rate = ( P + clamp(I8 - P, -c8, +c8) ) / K
import { all, SP } from "./skept-cap-lib.mjs";
import fs from "node:fs";
const toks = [...all.keys()].sort();
const P = [], R = [], T = [];
for (const t of toks) for (const r of all.get(t)) {
  if (!Number.isFinite(r.hl_rate) || !Number.isFinite(r.hl_premium)) continue;
  P.push(r.hl_premium); R.push(r.hl_rate); T.push(t);
}
const model = (p, I, c, K) => (p + Math.max(-c, Math.min(c, I - p))) / K;
function score(I, c, K, tol = 5e-11) {
  let sae = 0, mx = 0, exact = 0, imx = -1;
  for (let i = 0; i < P.length; i++) {
    const e = Math.abs(R[i] - model(P[i], I, c, K));
    sae += e; if (e > mx) { mx = e; imx = i; } if (e <= tol) exact++;
  }
  return { mae: sae / P.length, mx, imx, exactFrac: exact / P.length };
}
console.log("КАНДИДАТЫ ФОРМЫ (I8=0.0001 = 0.01% за 8ч, c8=0.0005 = 0.05%, K = делитель 8ч->1ч)");
for (const [I, c, K] of [[1e-4,5e-4,8],[1e-4,5e-4,1],[1.25e-5,6.25e-5,1],[1e-4,4e-4,8],[1e-4,6e-4,8],[1e-4,5e-4,24]]) {
  const s = score(I, c, K);
  console.log(` I=${I} c=${c} K=${K}: MAE=${s.mae.toExponential(3)} max=${s.mx.toExponential(3)} точных=${(100*s.exactFrac).toFixed(4)}%`);
}
const I = 1e-4, c = 5e-4, K = 8;
const s = score(I, c, K);
console.log(`\nПРИНЯТО: hl_rate = ( hl_premium + clamp(${I} - hl_premium, -${c}, +${c}) ) / ${K}`);
console.log(` MAE=${s.mae.toExponential(4)}  max|err|=${s.mx.toExponential(4)}  на токене ${T[s.imx]} (P=${P[s.imx]}, R=${R[s.imx]})`);
for (const tol of [1e-12, 1e-11, 1e-10, 1e-9, 1e-8, 1e-7]) {
  console.log(` совпадений в пределах ${tol}: ${(100*score(I,c,K,tol).exactFrac).toFixed(4)}%`);
}
// точность самого c: сканируем
let bl = 1e-4, bh = 1e-3;
for (let k = 0; k < 80; k++) { const a = bl+(bh-bl)/3, b = bh-(bh-bl)/3; if (score(I,a,K).mae < score(I,b,K).mae) bh=b; else bl=a; }
console.log(` c подобранное по MAE = ${((bl+bh)/2).toExponential(8)} (декларация 5e-4)`);
let il = 0, ih = 5e-4;
for (let k = 0; k < 80; k++) { const a = il+(ih-il)/3, b = ih-(ih-il)/3; if (score(a,c,K).mae < score(b,c,K).mae) ih=b; else il=a; }
console.log(` I подобранное по MAE = ${((il+ih)/2).toExponential(8)} (декларация 1e-4)`);

// РЕЖИМЫ
let inB = 0, up = 0, dn = 0;
for (const p of P) { const d = I - p; if (d > c) dn++; else if (d < -c) up++; else inB++; }
console.log(`\nРЕЖИМЫ ЧУВСТВИТЕЛЬНОСТИ dF/dP:`);
console.log(`  полоса P in [${(I-c).toExponential(2)}, ${(I+c).toExponential(2)}] : F = I/K = ${I/K} РОВНО, dF/dP = 0 : ${inB} ч = ${(100*inB/P.length).toFixed(2)}%`);
console.log(`  P выше полосы  F=(P-c)/K, dF/dP = 1/${K} : ${up} ч = ${(100*up/P.length).toFixed(2)}%`);
console.log(`  P ниже полосы  F=(P+c)/K, dF/dP = 1/${K} : ${dn} ч = ${(100*dn/P.length).toFixed(2)}%`);

// по каждому токену: доля вне полосы + распределение |P| относительно границ
const rows = [];
for (const t of toks) {
  const a = all.get(t); let n = 0, o = 0, sp = 0;
  const ps = [];
  for (const r of a) { if (!Number.isFinite(r.hl_premium)) continue; n++; ps.push(r.hl_premium); const d = I - r.hl_premium; if (Math.abs(d) > c) o++; }
  ps.sort((x,y)=>x-y);
  rows.push({ t, n, outFrac: o/n, p05: ps[Math.floor(.05*n)], p50: ps[Math.floor(.5*n)], p95: ps[Math.floor(.95*n)] });
}
rows.sort((a,b)=>b.outFrac-a.outFrac);
console.log("\nДОЛЯ ЧАСОВ ВНЕ ПОЛОСЫ (там и только там наш сдвиг премии влияет на ставку):");
console.log("токен      часов  внеПолосы   премия p05        p50         p95");
for (const r of [...rows.slice(0,10), ...rows.slice(-5)]) console.log(`${r.t.padEnd(10)} ${String(r.n).padStart(5)}  ${(100*r.outFrac).toFixed(2).padStart(6)}%  ${r.p05.toExponential(3).padStart(11)} ${r.p50.toExponential(3).padStart(11)} ${r.p95.toExponential(3).padStart(11)}`);
const wavg = rows.reduce((s,r)=>s+r.outFrac*r.n,0)/rows.reduce((s,r)=>s+r.n,0);
console.log(`медиана доли вне полосы по 93 токенам: ${(100*[...rows].sort((a,b)=>a.outFrac-b.outFrac)[46].outFrac).toFixed(2)}%, средневзвешенная ${(100*wavg).toFixed(2)}%`);
fs.writeFileSync(`${SP}/hlc-b-mech.json`, JSON.stringify({ I, c, K, mae: s.mae, maxErr: s.mx, inBandFrac: inB/P.length, byToken: rows }, null, 1));
