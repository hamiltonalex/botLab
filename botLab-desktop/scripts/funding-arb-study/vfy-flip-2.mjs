// СКЕПТИК, батарея 2: когда переключился флаг; правильная (гибридная) база; позиция против ВСЕГО рынка.
import fs from "node:fs";
import { SP } from "./skept-cap-lib.mjs";
const EARN = ["PENGU","BNB","DOT","PEPE","SEI","TAO","TRX","VIRTUAL","LINK","XRP","ADA"];
const q=(a,p)=>{const x=a.slice().sort((u,v)=>u-v);if(!x.length)return NaN;const i=(x.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return x[lo]+(x[hi]-x[lo])*(i-lo);};
const fm=(x)=>!Number.isFinite(x)?"н/д":x>=1e6?`$${(x/1e6).toFixed(2)}M`:x>=1e3?`$${(x/1e3).toFixed(1)}k`:`$${x.toFixed(0)}`;
const D=new Map(); for(const t of EARN) D.set(t,JSON.parse(fs.readFileSync(`${SP}/truth-a-oi2/${t}.json`,"utf8")).oi);

console.log("== 2в. КОГДА ФЛАГ ПЕРЕКЛЮЧИЛСЯ ==");
for (const [t,oi] of D) {
  const ch=[]; for(let i=1;i<oi.length;i++) if(oi[i].useOpenInterestInTokensForBalance!==oi[i-1].useOpenInterestInTokensForBalance)
    ch.push(`${new Date(oi[i].snapshotTimestamp*1000).toISOString().slice(0,13)} -> ${oi[i].useOpenInterestInTokensForBalance}`);
  console.log(`  ${t.padEnd(8)} первый=${oi[0].useOpenInterestInTokensForBalance} последний=${oi[oi.length-1].useOpenInterestInTokensForBalance} переключений=${ch.length}  ${ch.slice(0,3).join(" | ")}`);
}

// ГИБРИДНАЯ (по правилу GMX) база: флаг true -> OI в токенах, флаг false -> OI в USD.
// Обе величины приводим к USD, чтобы сравнивать с размером позиции.
function gapHybrid(r){
  const L=+r.longFundingBalanceOiUsd/1e30, S=+r.shortFundingBalanceOiUsd/1e30;
  const Lt=+r.longOpenInterestInTokens, St=+r.shortOpenInterestInTokens;
  if(!(L>0)||!(S>0)) return null;
  if(r.useOpenInterestInTokensForBalance===true){
    if(!(Lt>0)||!(St>0)) return null;
    const px=(L+S)/(Lt+St);
    return {gap:Math.abs(Lt-St)*px, small:Math.min(Lt,St)*px, big:Math.max(Lt,St)*px, tot:(Lt+St)*px, shortSmall:St<Lt};
  }
  return {gap:Math.abs(L-S), small:Math.min(L,S), big:Math.max(L,S), tot:L+S, shortSmall:S<L};
}

console.log("\n== 2г. ЧИСЛА УТВЕРЖДЕНИЯ НА ПРАВИЛЬНОЙ (ГИБРИДНОЙ) БАЗЕ ==");
console.log("| рынок | медиана разрыва (заявлено) | медиана разрыва (гибрид) | доля $100k>разрыв заявл. | гибрид |");
console.log("|---|---|---|---|---|");
for (const [t,oi] of D){
  const a=[],b=[]; let n1=0,n2=0,tot=0;
  for(const r of oi){const L=+r.longFundingBalanceOiUsd/1e30,S=+r.shortFundingBalanceOiUsd/1e30; if(!(L>0&&S>0))continue;
    const h=gapHybrid(r); if(!h)continue; tot++; a.push(Math.abs(L-S)); b.push(h.gap);
    if(1e5>Math.abs(L-S))n1++; if(1e5>h.gap)n2++;}
  console.log(`| ${t} | ${fm(q(a,.5))} | ${fm(q(b,.5))} | ${(100*n1/tot).toFixed(1)}% | ${(100*n2/tot).toFixed(1)}% |`);
}

console.log("\n== НОВОЕ: РАЗМЕР ПОЗИЦИИ ПРОТИВ ВСЕГО РЫНКА (гибридная база) ==");
console.log("| рынок | медиана всего OI (L+S) | медиана меньшей стороны | $100k / меньшая сторона | $100k / весь OI |");
console.log("|---|---|---|---|---|");
for (const [t,oi] of D){
  const tt=[],ss=[];
  for(const r of oi){const h=gapHybrid(r); if(!h)continue; tt.push(h.tot); ss.push(h.small);}
  console.log(`| ${t} | ${fm(q(tt,.5))} | ${fm(q(ss,.5))} | ${(1e5/q(ss,.5)).toFixed(2)}x | ${(1e5/q(tt,.5)).toFixed(2)}x |`);
}
