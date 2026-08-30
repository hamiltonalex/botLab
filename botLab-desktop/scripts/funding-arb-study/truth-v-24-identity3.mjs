import {q,MAP,all} from "./truth-v-lib.mjs";
const S=["BTC","ETH","SOL","PEPE","BOME","ORDI","FET","S","DOT","TRX","XLM","MELANIA","WIF","BONK","DYDX","MEME"];
let e=[], n=0, byT=[];
for(const t of S){ const a=MAP.get(t).market, rows=all.get(t);
  const t0=rows[0].tsHour, t1=rows[rows.length-1].tsHour+3600;
  let cur=t0, got=new Map();
  while(cur<t1){ const d=await q(`{ fundingBalanceOiSnapshots(limit:1000, orderBy: snapshotTimestamp_ASC, where:{marketAddress_eq:"${a}", snapshotTimestamp_gte:${cur}, snapshotTimestamp_lt:${t1}}){ snapshotTimestamp longOpenInterestInTokens shortOpenInterestInTokens } }`);
    const s=d.fundingBalanceOiSnapshots; if(!s.length)break;
    for(const x of s) got.set(x.snapshotTimestamp,[Number(x.longOpenInterestInTokens),Number(x.shortOpenInterestInTokens)]);
    cur=s[s.length-1].snapshotTimestamp+1; if(s.length<1000)break; }
  let te=[];
  for(const r of rows){ const o=got.get(r.tsHour); if(!o)continue; const [L,Sh]=o; if(!(L>0&&Sh>0))continue;
    const payLong=r.f_long<0; const fp=Math.abs(payLong?r.f_long:r.f_short), fr=Math.abs(payLong?r.f_short:r.f_long);
    if(!(fp>0&&fr>0))continue; const pred=fp*(payLong?L:Sh)/(payLong?Sh:L);
    te.push(Math.abs(pred-fr)/fr); }
  e.push(...te); byT.push({t,n:te.length,ok:100*te.filter(x=>x<1e-4).length/te.length});
  process.stderr.write(`${t} `); }
e.sort((a,b)=>a-b);
console.log(`\nТОЖДЕСТВО |f_получателя| = |f_плательщика| * OI_плательщика(В ТОКЕНАХ) / OI_получателя(В ТОКЕНАХ)`);
console.log(`проверено ${e.length} часов на ${S.length} рынках`);
console.log(`доля часов с ошибкой <0.01%: ${(100*e.filter(x=>x<1e-4).length/e.length).toFixed(2)}%`);
console.log(`доля часов с ошибкой <1%:    ${(100*e.filter(x=>x<0.01).length/e.length).toFixed(2)}%`);
console.log(`медиана ошибки ${(100*e[Math.floor(e.length/2)]).toExponential(2)}%, p99 ${(100*e[Math.floor(e.length*0.99)]).toExponential(2)}%`);
console.log("\nпо рынкам, доля часов с ошибкой <0.01%:");
for(const r of byT) console.log(`  ${r.t.padEnd(9)} ${r.ok.toFixed(2)}%  (${r.n} часов)`);
