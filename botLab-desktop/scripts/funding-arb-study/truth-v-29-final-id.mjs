import {q,MAP,all,SP} from "./truth-v-lib.mjs"; import fs from "node:fs";
const S=["BTC","ETH","SOL","LINK","XRP","PEPE","DOT","TRX","S","FET","WIF","MEME","BOME","ORDI","MELANIA","BONK","BERA","MOODENG"];
let N=0,OK=0; const rowsOut=[];
for(const t of S){ const a=MAP.get(t).market, rows=all.get(t);
  const t0=rows[0].tsHour,t1=rows[rows.length-1].tsHour+3600; let cur=t0,got=new Map();
  while(cur<t1){ const d=await q(`{ fundingBalanceOiSnapshots(limit:1000, orderBy: snapshotTimestamp_ASC, where:{marketAddress_eq:"${a}", snapshotTimestamp_gte:${cur}, snapshotTimestamp_lt:${t1}}){ snapshotTimestamp longFundingBalanceOiUsd shortFundingBalanceOiUsd } }`);
    const s=d.fundingBalanceOiSnapshots; if(!s.length)break;
    for(const x of s) got.set(x.snapshotTimestamp,[Number(x.longFundingBalanceOiUsd),Number(x.shortFundingBalanceOiUsd)]);
    cur=s[s.length-1].snapshotTimestamp+1; if(s.length<1000)break; }
  let n=0,ok=0,worst=0;
  for(const r of rows){ const o=got.get(r.tsHour); if(!o)continue; const [L,Sh]=o;
    const fl=Math.abs(r.f_long),fsh=Math.abs(r.f_short); if(!(fl>0&&fsh>0&&L>0&&Sh>0))continue;
    const A=fl*L,B=fsh*Sh, e=Math.abs(A-B)/Math.max(A,B); n++; if(e<1e-4)ok++; if(e>worst)worst=e; }
  N+=n; OK+=ok; rowsOut.push({t,n,ok:100*ok/n,worst});
  console.log(`${t.padEnd(9)} часов ${String(n).padStart(5)}  тождество держится ${(100*ok/n).toFixed(3)}%  худшая ошибка ${(100*worst).toExponential(2)}%`);
}
console.log(`\nИТОГО: ${OK} из ${N} часов = ${(100*OK/N).toFixed(4)}%`);
