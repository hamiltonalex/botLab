import {q,MAP,all,SP} from "./truth-v-lib.mjs"; import fs from "node:fs";
const OIU=JSON.parse(fs.readFileSync(`${SP}/truth-v-oi.json`,"utf8"));
for(const t of ["BTC","BOME","ORDI"]){ const a=MAP.get(t).market, rows=all.get(t);
  const t0=rows[0].tsHour,t1=rows[rows.length-1].tsHour+3600; let cur=t0,got=new Map();
  while(cur<t1){ const d=await q(`{ fundingBalanceOiSnapshots(limit:1000, orderBy: snapshotTimestamp_ASC, where:{marketAddress_eq:"${a}", snapshotTimestamp_gte:${cur}, snapshotTimestamp_lt:${t1}}){ snapshotTimestamp longOpenInterestInTokens shortOpenInterestInTokens longFundingBalanceOiUsd shortFundingBalanceOiUsd } }`);
    const s=d.fundingBalanceOiSnapshots; if(!s.length)break;
    for(const x of s) got.set(x.snapshotTimestamp,x); cur=s[s.length-1].snapshotTimestamp+1; if(s.length<1000)break; }
  const um=new Map(OIU[t].map(([ts,L,S])=>[ts,[L,S]]));
  let n=0,tok=0,usd=0,fb=0,any=0;
  for(const r of rows){ const x=got.get(r.tsHour), u=um.get(r.tsHour); if(!x||!u)continue;
    const fl=Math.abs(r.f_long), fs_=Math.abs(r.f_short); if(!(fl>0&&fs_>0))continue;
    const chk=(L,S)=>{ if(!(L>0&&S>0))return false; return Math.abs(fl*L-fs_*S)/Math.max(fl*L,fs_*S)<1e-4; };
    n++;
    const a1=chk(Number(x.longOpenInterestInTokens),Number(x.shortOpenInterestInTokens));
    const a2=chk(u[0],u[1]);
    const a3=chk(Number(x.longFundingBalanceOiUsd),Number(x.shortFundingBalanceOiUsd));
    if(a1)tok++; if(a2)usd++; if(a3)fb++; if(a1||a2||a3)any++; }
  console.log(`${t}: часов ${n} | по OI в токенах ${(100*tok/n).toFixed(2)}% | по OI в USD ${(100*usd/n).toFixed(2)}% | по fundingBalanceOi ${(100*fb/n).toFixed(2)}% | ЛЮБОЙ ${(100*any/n).toFixed(2)}%`);
}
