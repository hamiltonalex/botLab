// СКЕПТИК, батарея 4: ИНЕРЦИЯ. Переворот баз против переворота ЗНАКА ставки.
import fs from "node:fs";
import { SP, all } from "./skept-cap-lib.mjs";
const EARN=["PENGU","BNB","DOT","PEPE","SEI","TAO","TRX","VIRTUAL","LINK","XRP","ADA"];
const q=(a,p)=>{const x=a.slice().sort((u,v)=>u-v);if(!x.length)return NaN;const i=(x.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return x[lo]+(x[hi]-x[lo])*(i-lo);};

function series(t){
  const oi=JSON.parse(fs.readFileSync(`${SP}/truth-a-oi2/${t}.json`,"utf8")).oi;
  const byTs=new Map(all.get(t).map(r=>[r.tsHour,r]));
  const out=[];
  for(const r of oi){
    const c=byTs.get(r.snapshotTimestamp); if(!c) continue;
    const L=+r.longFundingBalanceOiUsd/1e30,S=+r.shortFundingBalanceOiUsd/1e30;
    if(!(L>0&&S>0)) { out.push(null); continue; }
    // знак из первоисточника: f_short>0 => шорт получает, платит ЛОНГ.
    let payer=null;
    if(c.f_short>0&&c.f_long<0) payer="long";
    else if(c.f_long>0&&c.f_short<0) payer="short";
    out.push({ts:r.snapshotTimestamp, big:L>S?"long":"short", payer, gap:Math.abs(L-S), L,S});
  }
  return out;
}

console.log("== 1а. СОГЛАСИЕ: платит ли БОЛЬШАЯ сторона (по часам, где знак определён) ==");
console.log("| рынок | часов со знаком | платит большая | платит МЕНЬШАЯ |");
console.log("|---|---|---|---|");
const SER=new Map();
for(const t of EARN){ const s=series(t); SER.set(t,s);
  let ok=0,tot=0; for(const r of s){ if(!r||!r.payer)continue; tot++; if(r.payer===r.big)ok++; }
  console.log(`| ${t} | ${tot} | ${(100*ok/tot).toFixed(1)}% | ${(100*(tot-ok)/tot).toFixed(1)}% |`);
}

console.log("\n== 1б. СОБЫТИЯ ПЕРЕВОРОТА БАЗ: через сколько часов переворачивается ЗНАК ставки ==");
console.log("(событие = устойчивый переворот big: одинаков >=6ч до и >=24ч после; ищем первый час, когда payer стал равен новой big)");
console.log("| рынок | событий | p25 | медиана | p75 | p90 | не случилось за 72ч | мгновенно (0ч) |");
console.log("|---|---|---|---|---|---|---|---|");
const ALL=[];
for(const t of EARN){
  const s=SER.get(t); const lags=[]; let never=0, inst=0;
  for(let i=6;i<s.length-24;i++){
    const a=s[i-1],b=s[i]; if(!a||!b||a.big===b.big) continue;
    let stableBefore=true; for(let k=i-6;k<i;k++){ if(!s[k]||s[k].big!==a.big){stableBefore=false;break;} }
    let stableAfter=true;  for(let k=i;k<i+24;k++){ if(!s[k]||s[k].big!==b.big){stableAfter=false;break;} }
    if(!stableBefore||!stableAfter) continue;
    // знак перед событием должен соответствовать СТАРОЙ большой стороне (иначе это не «переворот платежа»)
    if(!a.payer||a.payer!==a.big) continue;
    let lag=-1;
    for(let k=0;k<=72&&i+k<s.length;k++){ const r=s[i+k]; if(r&&r.payer===b.big){lag=k;break;} }
    if(lag<0) never++; else { lags.push(lag); if(lag===0)inst++; ALL.push(lag); }
  }
  const n=lags.length+never;
  console.log(`| ${t} | ${n} | ${lags.length?q(lags,.25).toFixed(0):"-"} | ${lags.length?q(lags,.5).toFixed(0):"-"} | ${lags.length?q(lags,.75).toFixed(0):"-"} | ${lags.length?q(lags,.9).toFixed(0):"-"} | ${n?(100*never/n).toFixed(0):"-"}% | ${n?(100*inst/n).toFixed(0):"-"}% |`);
}
console.log(`\n  ВСЕ РЫНКИ ВМЕСТЕ: n=${ALL.length}, p25=${q(ALL,.25).toFixed(0)}ч, медиана=${q(ALL,.5).toFixed(0)}ч, p75=${q(ALL,.75).toFixed(0)}ч, p90=${q(ALL,.9).toFixed(0)}ч`);

console.log("\n== 1в. ОБРАТНЫЙ ЗАМЕР: длина периодов рассогласования (payer != big) ==");
console.log("| рынок | серий | медиана длины, ч | p90 | максимум |");
console.log("|---|---|---|---|---|");
for(const t of EARN){
  const s=SER.get(t); const runs=[]; let cur=0;
  for(const r of s){ if(!r||!r.payer){ if(cur){runs.push(cur);cur=0;} continue; }
    if(r.payer!==r.big) cur++; else if(cur){runs.push(cur);cur=0;} }
  if(cur)runs.push(cur);
  console.log(`| ${t} | ${runs.length} | ${q(runs,.5).toFixed(0)} | ${q(runs,.9).toFixed(0)} | ${Math.max(...runs)} |`);
}
