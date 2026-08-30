import * as L from "./hlc-skept-lib.mjs";
const cl=(x,a,b)=>Math.min(b,Math.max(a,x));
// A. формула замера 2
let n=0,bad=0,maxe=0;
// B. формула замера 1 (i и кламп в ЧАСОВОМ масштабе)
let bad1=0, tol1=0;
const baseHours=[]; let inBand=0, band=0;
for(const [t,rows] of L.all) for(const r of rows){
  const p=r.hl_premium; if(!Number.isFinite(p)) continue; n++;
  const f2=(p+cl(1e-4-p,-5e-4,5e-4))/8; const e=Math.abs(f2-r.hl_rate); maxe=Math.max(maxe,e); if(e>1e-10) bad++;
  const f1=p+cl(1.25e-5-p,-5e-4,5e-4); if(Math.abs(f1-r.hl_rate)>1e-12) bad1++; else tol1++;
  if(Math.abs(r.hl_rate-1.25e-5)<1e-12){ band++; baseHours.push(p); }
}
console.log(`часов с премией: ${n}`);
console.log(`формула замера 2  f=(p+clamp(1e-4-p,±5e-4))/8 : несовпадений ${bad} (${(100*bad/n).toFixed(4)}%), max|err| ${maxe.toExponential(2)}`);
console.log(`формула замера 1  f=p+clamp(1.25e-5-p,±5e-4)  : совпадений бит-в-бит ${(100*tol1/n).toFixed(2)}%  <- замер 1 заявлял 56.11% и объяснял остаток "усреднением премии внутри часа"`);
console.log(`\nТАВТОЛОГИЯ? В ${band} часах со ставкой РОВНО на базе премия при этом:`);
const s=baseHours;
console.log(`  уникальных значений премии ${new Set(s).size}, диапазон ${L.q(s,0).toExponential(2)}..${L.q(s,1).toExponential(2)}, p5 ${L.q(s,0.05).toExponential(2)}, p95 ${L.q(s,0.95).toExponential(2)}`);
console.log(`  доля этих премий внутри полосы [-4e-4,+6e-4]: ${(100*s.filter(x=>x>=-4e-4&&x<=6e-4).length/s.length).toFixed(2)}%`);
console.log(`  вывод: премия меняется непрерывно там, где ставка постоянна => премия НЕ пересчёт ставки, это независимо публикуемый вход формулы.`);
// сколько информации в премии сверх ставки
let out=0; for(const [t,rows] of L.all) for(const r of rows) if(Math.abs(r.hl_rate-1.25e-5)>1e-12) out++;
console.log(`  часов вне полосы (там ставка = премия/8 + const): ${(100*out/n).toFixed(2)}%`);
