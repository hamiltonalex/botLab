// СКЕПТИК, расчёт 2, батарея 1: воспроизведение + флаг + распределение + чья сторона меньше.
import fs from "node:fs";
import { SP, all, YEAR } from "./skept-cap-lib.mjs";
const EARN = ["PENGU","BNB","DOT","PEPE","SEI","TAO","TRX","VIRTUAL","LINK","XRP","ADA"];
const q = (a,p)=>{const x=a.slice().sort((u,v)=>u-v); if(!x.length) return NaN; const i=(x.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i); return x[lo]+(x[hi]-x[lo])*(i-lo);};
const fm = (x)=>!Number.isFinite(x)?"н/д":x>=1e6?`$${(x/1e6).toFixed(2)}M`:x>=1e3?`$${(x/1e3).toFixed(1)}k`:`$${x.toFixed(0)}`;

const D = new Map();
for (const t of EARN) {
  const p = `${SP}/truth-a-oi2/${t}.json`;
  if (!fs.existsSync(p)) { console.log(`НЕТ ДАННЫХ ${t}`); continue; }
  D.set(t, JSON.parse(fs.readFileSync(p,"utf8")).oi);
}

console.log("== 0. ВОСПРОИЗВЕДЕНИЕ утверждения (медиана |L-S| и доля часов, где $100k > |L-S|) ==");
console.log("| рынок | часов | медиана |L-S| | доля $100k>разрыв |");
console.log("|---|---|---|---|");
for (const [t,oi] of D) {
  const g=[]; let n=0,tot=0;
  for (const r of oi) { const L=+r.longFundingBalanceOiUsd/1e30, S=+r.shortFundingBalanceOiUsd/1e30;
    if(!(L>0)||!(S>0)) continue; g.push(Math.abs(L-S)); tot++; if(100000>Math.abs(L-S)) n++; }
  console.log(`| ${t} | ${tot} | ${fm(q(g,0.5))} | ${(100*n/tot).toFixed(1)}% |`);
}

console.log("\n== 2. ФЛАГ useOpenInterestInTokensForBalance ==");
for (const [t,oi] of D) {
  const tr = oi.filter(r=>r.useOpenInterestInTokensForBalance===true).length;
  console.log(`  ${t.padEnd(8)} true в ${tr}/${oi.length} часах`);
}

console.log("\n== 2а. РАЗРЫВ ПО OI В ТОКЕНАХ, переведённый в USD по цене OI_usd/OI_tokens ==");
console.log("| рынок | медиана |L-S| по USD-базе | медиана |L-S| по токен-базе | отношение |");
console.log("|---|---|---|---|");
for (const [t,oi] of D) {
  const a=[],b=[];
  for (const r of oi) {
    const L=+r.longFundingBalanceOiUsd/1e30, S=+r.shortFundingBalanceOiUsd/1e30;
    const Lt=+r.longOpenInterestInTokens, St=+r.shortOpenInterestInTokens;
    if(!(L>0)||!(S>0)||!(Lt>0)||!(St>0)) continue;
    a.push(Math.abs(L-S));
    // цена в USD за токен-единицу (в тех же сырых единицах): усредняем обе стороны
    const px=(L+S)/(Lt+St);
    b.push(Math.abs(Lt-St)*px);
  }
  console.log(`| ${t} | ${fm(q(a,0.5))} | ${fm(q(b,0.5))} | ${(q(b,0.5)/q(a,0.5)).toFixed(3)} |`);
}

console.log("\n== 3. РАСПРЕДЕЛЕНИЕ разрыва |L-S| (перцентили) ==");
console.log("| рынок | p10 | p25 | p50 | p75 | p90 | p99 | max |");
console.log("|---|---|---|---|---|---|---|---|");
for (const [t,oi] of D) {
  const g=[];
  for (const r of oi){const L=+r.longFundingBalanceOiUsd/1e30,S=+r.shortFundingBalanceOiUsd/1e30; if(L>0&&S>0) g.push(Math.abs(L-S));}
  console.log(`| ${t} | ${fm(q(g,.1))} | ${fm(q(g,.25))} | ${fm(q(g,.5))} | ${fm(q(g,.75))} | ${fm(q(g,.9))} | ${fm(q(g,.99))} | ${fm(q(g,1))} |`);
}

console.log("\n== 3б. РАЗМЕР САМИХ СТОРОН (медианы), чтобы видеть масштаб рынка ==");
console.log("| рынок | медиана long-базы | медиана short-базы | медиана меньшей |");
console.log("|---|---|---|---|");
for (const [t,oi] of D) {
  const L=[],S=[],m=[];
  for (const r of oi){const a=+r.longFundingBalanceOiUsd/1e30,b=+r.shortFundingBalanceOiUsd/1e30; if(a>0&&b>0){L.push(a);S.push(b);m.push(Math.min(a,b));}}
  console.log(`| ${t} | ${fm(q(L,.5))} | ${fm(q(S,.5))} | ${fm(q(m,.5))} |`);
}

console.log("\n== 2б. КАК ЧАСТО ШОРТ-СТОРОНА GMX МЕНЬШЕ ЛОНГ-СТОРОНЫ ==");
console.log("| рынок | доля часов short<long |");
console.log("|---|---|");
for (const [t,oi] of D) {
  let n=0,tot=0;
  for (const r of oi){const L=+r.longFundingBalanceOiUsd/1e30,S=+r.shortFundingBalanceOiUsd/1e30; if(L>0&&S>0){tot++; if(S<L)n++;}}
  console.log(`| ${t} | ${(100*n/tot).toFixed(1)}% |`);
}
