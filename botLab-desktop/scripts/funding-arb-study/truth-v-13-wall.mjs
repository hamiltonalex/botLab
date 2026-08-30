import {q,MAP,all,SP,apr} from "./truth-v-lib.mjs"; import fs from "node:fs";
const cap=JSON.parse(fs.readFileSync(`${SP}/truth-v-cap.json`,"utf8"));
const capBy=new Map(cap.map(r=>[r.t,Number(r.maxFundingFactorPerSecondLong)/1e30]));
const YEAR=8761, full=[...all.keys()].filter(t=>all.get(t).length===YEAR);
console.log("СТЕНА ПЛАТЯЩЕЙ СТОРОНЫ: годовой максимум min(|f_long|,|f_short|) по рынкам");
const w=[];
for(const t of full){ const rows=all.get(t); const mn=rows.map(r=>Math.min(Math.abs(r.f_long),Math.abs(r.f_short)));
  const mx=Math.max(...mn); const near=mn.filter(v=>v>=mx*0.99).length;
  w.push({t,mx,near,c:capBy.get(t)}); }
w.sort((a,b)=>b.mx-a.mx);
console.log("рынок      max платящей   % год     часов в 1% от него   тек.протокол.max  отношение");
for(const r of w) console.log(`${r.t.padEnd(10)} ${r.mx.toExponential(4)}  ${apr(r.mx).toFixed(1).padStart(7)}   ${String(r.near).padStart(5)}                ${r.c.toExponential(3)}    ${(r.mx/r.c).toFixed(1)}x`);
const mxs=w.map(r=>r.mx);
console.log(`\nмедиана стены по рынкам: ${mxs.sort((a,b)=>a-b)[Math.floor(mxs.length/2)].toExponential(4)} = ${apr(mxs[Math.floor(mxs.length/2)]).toFixed(0)}% год`);
console.log(`минимальная стена: ${mxs[0].toExponential(4)} = ${apr(mxs[0]).toFixed(0)}%; максимальная: ${mxs[mxs.length-1].toExponential(4)} = ${apr(mxs[mxs.length-1]).toFixed(0)}%`);
// свежие 60 суток: держит ли потолок ПЛАТЯЩУЮ сторону сейчас
console.log("\nСВЕЖИЕ 60 СУТОК: платящая сторона против ТЕКУЩЕГО протокольного max");
const now=Math.floor(Date.now()/1000), t0=now-60*86400;
for(const t of ["BTC","ETH","SOL","PEPE","BOME","ORDI","FET","S","DOT","BONK"]){
  const a=MAP.get(t).market, c=capBy.get(t); let cur=t0, vals=[];
  while(cur<now){ const d=await q(`{ fundingRateSnapshots(limit:1000, orderBy: snapshotTimestamp_ASC, where:{marketAddress_eq:"${a}", snapshotTimestamp_gte:${cur}, snapshotTimestamp_lt:${now}}){ snapshotTimestamp fundingFactorPerSecondLong fundingFactorPerSecondShort } }`);
    const s=d.fundingRateSnapshots; if(!s.length)break; vals.push(...s); cur=s[s.length-1].snapshotTimestamp+1; if(s.length<1000)break; }
  const mn=vals.map(x=>Math.min(Math.abs(Number(x.fundingFactorPerSecondLong)/1e30),Math.abs(Number(x.fundingFactorPerSecondShort)/1e30)));
  const above=mn.filter(v=>v>c*1.0001).length, eq=mn.filter(v=>Math.abs(v-c)/c<1e-6).length;
  console.log(`  ${t.padEnd(9)} часов ${mn.length}  платящая выше max: ${(100*above/mn.length).toFixed(1)}%  ровно НА max: ${(100*eq/mn.length).toFixed(1)}%  max платящей=${Math.max(...mn).toExponential(3)} (${apr(Math.max(...mn)).toFixed(0)}%) при max=${apr(c).toFixed(0)}%`);
}
