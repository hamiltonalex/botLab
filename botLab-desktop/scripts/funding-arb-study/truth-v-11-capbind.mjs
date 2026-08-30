import {q,MAP,all,SP,apr} from "./truth-v-lib.mjs"; import fs from "node:fs";
const cap=JSON.parse(fs.readFileSync(`${SP}/truth-v-cap.json`,"utf8"));
const capBy=new Map(cap.map(r=>[r.t,Number(r.maxFundingFactorPerSecondLong)/1e30]));
// СВЕЖИЕ данные вне кэша: последние 60 суток, 12 рынков
const now=Math.floor(Date.now()/1000), t0=now-60*86400;
console.log("СВЕЖИЕ 60 СУТОК (вне кэша): держится ли протокольный потолок?");
console.log("рынок     снимков  выше max  ровно НА max  max|f| факт     протокол.max    отношение");
const toks=["BTC","ETH","SOL","PEPE","BOME","ORDI","FET","S","DOT","TRX","XLM","MELANIA","WIF","BONK","DYDX"];
let tot=0,ab=0;
for(const t of toks){ const a=MAP.get(t).market; const c=capBy.get(t);
  let cur=t0, vals=[];
  while(cur<now){ const d=await q(`{ fundingRateSnapshots(limit:1000, orderBy: snapshotTimestamp_ASC, where:{marketAddress_eq:"${a}", snapshotTimestamp_gte:${cur}, snapshotTimestamp_lt:${now}}){ snapshotTimestamp fundingFactorPerSecondLong fundingFactorPerSecondShort } }`);
    const s=d.fundingRateSnapshots; if(!s.length) break;
    vals.push(...s); cur=s[s.length-1].snapshotTimestamp+1; if(s.length<1000) break; }
  const v=vals.flatMap(x=>[Math.abs(Number(x.fundingFactorPerSecondLong)/1e30),Math.abs(Number(x.fundingFactorPerSecondShort)/1e30)]);
  const above=v.filter(x=>x>c*1.0001).length, eq=v.filter(x=>Math.abs(x-c)/c<1e-9).length;
  const mx=Math.max(...v); tot+=v.length; ab+=above;
  console.log(`${t.padEnd(9)} ${String(v.length).padStart(6)}  ${String(above).padStart(7)}  ${String(eq).padStart(11)}  ${mx.toExponential(3)} (${apr(mx).toFixed(0)}%)  ${c.toExponential(3)} (${apr(c).toFixed(0)}%)  ${(mx/c).toFixed(2)}x`);
}
console.log(`\nитого свежих значений ${tot}, выше протокольного max: ${ab} = ${(100*ab/tot).toFixed(2)}%`);
