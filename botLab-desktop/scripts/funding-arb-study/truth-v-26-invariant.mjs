import {q,MAP,all} from "./truth-v-lib.mjs";
// СИММЕТРИЧНЫЙ инвариант: |f_long| * OI_long(в токенах) == |f_short| * OI_short(в токенах)
const S=["BTC","ETH","PEPE","BOME","ORDI","MELANIA","WIF","DOT"];
let e=[], byT=[];
for(const t of S){ const a=MAP.get(t).market, rows=all.get(t);
  const t0=rows[0].tsHour, t1=rows[rows.length-1].tsHour+3600; let cur=t0, got=new Map();
  while(cur<t1){ const d=await q(`{ fundingBalanceOiSnapshots(limit:1000, orderBy: snapshotTimestamp_ASC, where:{marketAddress_eq:"${a}", snapshotTimestamp_gte:${cur}, snapshotTimestamp_lt:${t1}}){ snapshotTimestamp longOpenInterestInTokens shortOpenInterestInTokens } }`);
    const s=d.fundingBalanceOiSnapshots; if(!s.length)break;
    for(const x of s) got.set(x.snapshotTimestamp,[Number(x.longOpenInterestInTokens),Number(x.shortOpenInterestInTokens)]);
    cur=s[s.length-1].snapshotTimestamp+1; if(s.length<1000)break; }
  let te=[];
  for(const r of rows){ const o=got.get(r.tsHour); if(!o)continue; const [L,Sh]=o; if(!(L>0&&Sh>0))continue;
    const A=Math.abs(r.f_long)*L, B=Math.abs(r.f_short)*Sh; if(!(A>0&&B>0))continue;
    te.push(Math.abs(A-B)/Math.max(A,B)); }
  e.push(...te); byT.push({t,n:te.length,ok:100*te.filter(x=>x<1e-4).length/te.length,ok1:100*te.filter(x=>x<0.01).length/te.length});
  process.stderr.write(`${t} `); }
e.sort((a,b)=>a-b);
console.log(`\nИНВАРИАНТ  |f_long| * OI_long(токены) = |f_short| * OI_short(токены)`);
console.log(`проверено ${e.length} часов на ${S.length} рынках`);
console.log(`ошибка <0.01%: ${(100*e.filter(x=>x<1e-4).length/e.length).toFixed(2)}%   <1%: ${(100*e.filter(x=>x<0.01).length/e.length).toFixed(2)}%   <5%: ${(100*e.filter(x=>x<0.05).length/e.length).toFixed(2)}%`);
console.log(`медиана ${(100*e[Math.floor(e.length/2)]).toExponential(2)}%  p95 ${(100*e[Math.floor(e.length*0.95)]).toExponential(2)}%  p99 ${(100*e[Math.floor(e.length*0.99)]).toExponential(2)}%`);
for(const r of byT) console.log(`  ${r.t.padEnd(9)} <0.01%: ${r.ok.toFixed(2)}%  <1%: ${r.ok1.toFixed(2)}%  (${r.n} часов)`);
