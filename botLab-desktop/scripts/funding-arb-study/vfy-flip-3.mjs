// СКЕПТИК, батарея 3: КАКАЯ база настоящая. Тождество GMX по каждой из двух баз, отдельно по эпохам флага.
import fs from "node:fs";
import { SP, all, YEAR } from "./skept-cap-lib.mjs";
const EARN=["PENGU","BNB","DOT","PEPE","SEI","TAO","TRX","VIRTUAL","LINK","XRP","ADA"];
const q=(a,p)=>{const x=a.slice().sort((u,v)=>u-v);if(!x.length)return NaN;const i=(x.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return x[lo]+(x[hi]-x[lo])*(i-lo);};
console.log("| рынок | эпоха | n | медиана относит. невязки USD-базы | токен-базы |");
console.log("|---|---|---|---|---|");
for(const t of EARN){
  const oi=JSON.parse(fs.readFileSync(`${SP}/truth-a-oi2/${t}.json`,"utf8")).oi;
  const rows=all.get(t); const byTs=new Map(rows.map(r=>[r.tsHour,r]));
  const acc={false:{u:[],k:[]},true:{u:[],k:[]}};
  for(const r of oi){
    const c=byTs.get(r.snapshotTimestamp); if(!c) continue;
    const fl=Math.abs(c.f_long), fs_=Math.abs(c.f_short); if(!(fl>0)||!(fs_>0)) continue;
    const L=+r.longFundingBalanceOiUsd/1e30,S=+r.shortFundingBalanceOiUsd/1e30;
    const Lt=+r.longOpenInterestInTokens,St=+r.shortOpenInterestInTokens;
    const k=String(r.useOpenInterestInTokensForBalance);
    if(L>0&&S>0){const a=fl*L,b=fs_*S; acc[k].u.push(Math.abs(a-b)/Math.max(a,b));}
    if(Lt>0&&St>0){const a=fl*Lt,b=fs_*St; acc[k].k.push(Math.abs(a-b)/Math.max(a,b));}
  }
  for(const k of ["false","true"]) if(acc[k].u.length)
    console.log(`| ${t} | флаг=${k} | ${acc[k].u.length} | ${q(acc[k].u,.5).toExponential(2)} | ${q(acc[k].k,.5).toExponential(2)} |`);
}
console.log("\n== Прямая сверка: совпадает ли |Lt-St|*px с |L-S| в каждой эпохе ==");
for(const t of EARN){
  const oi=JSON.parse(fs.readFileSync(`${SP}/truth-a-oi2/${t}.json`,"utf8")).oi;
  const acc={false:[],true:[]};
  for(const r of oi){
    const L=+r.longFundingBalanceOiUsd/1e30,S=+r.shortFundingBalanceOiUsd/1e30;
    const Lt=+r.longOpenInterestInTokens,St=+r.shortOpenInterestInTokens;
    if(!(L>0&&S>0&&Lt>0&&St>0))continue;
    const px=(L+S)/(Lt+St);
    acc[String(r.useOpenInterestInTokensForBalance)].push(Math.abs(Lt-St)*px/Math.abs(L-S));
  }
  console.log(`  ${t.padEnd(8)} флаг=false медиана отношения ${q(acc.false,.5).toFixed(3)} (n=${acc.false.length});  флаг=true ${q(acc.true,.5).toFixed(3)} (n=${acc.true.length})`);
}
