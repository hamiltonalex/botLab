import {q,MAP,all,SP} from "./truth-v-lib.mjs"; import fs from "node:fs";
const runs=JSON.parse(fs.readFileSync(`${SP}/truth-v-runs.json`,"utf8")).filter(r=>r.n>=100).sort((a,b)=>b.n-a.n).slice(0,12);
console.log("ЖИВ ЛИ ИНДЕКСАТОР В ЗАМОРОЖЕННОМ ОКНЕ (тот же squid, тот же рынок, те же часы, ДРУГИЕ сущности)");
console.log("токен     часов  снимков ставки  разных f  снимков займа  разных b_long  разных индекс.цены  разных OI");
for(const r of runs){
  const a=MAP.get(r.t).market, rows=all.get(r.t).slice(r.s,r.e+1);
  const bl=new Set(rows.map(x=>x.b_long)).size;
  let cur=r.ts0, fs_=[], bs=[], oi=[];
  const pull=async(ent,fields)=>{ let c=r.ts0,out=[];
    while(c<r.ts1+3600){ const d=await q(`{ ${ent}(limit:1000, orderBy: snapshotTimestamp_ASC, where:{${ent==="borrowingRateSnapshots"?"address_eq":"marketAddress_eq"}:"${a}", snapshotTimestamp_gte:${c}, snapshotTimestamp_lte:${r.ts1}}){ snapshotTimestamp ${fields} } }`);
      const s=d[ent]; if(!s.length)break; out.push(...s); c=s[s.length-1].snapshotTimestamp+1; if(s.length<1000)break; }
    return out; };
  const F=await pull("fundingRateSnapshots","fundingFactorPerSecondLong fundingFactorPerSecondShort");
  const B=await pull("borrowingRateSnapshots","borrowingFactorPerSecondLong borrowingFactorPerSecondShort");
  const O=await pull("fundingBalanceOiSnapshots","longOpenInterestUsd shortOpenInterestUsd indexTokenMinPrice");
  const u=(arr,f)=>new Set(arr.map(f)).size;
  console.log(`${r.t.padEnd(9)} ${String(r.n).padStart(5)}  ${String(F.length).padStart(14)}  ${String(u(F,x=>x.fundingFactorPerSecondLong+"|"+x.fundingFactorPerSecondShort)).padStart(8)}  ${String(B.length).padStart(13)}  ${String(u(B,x=>x.borrowingFactorPerSecondLong)).padStart(13)}  ${String(u(O,x=>x.indexTokenMinPrice)).padStart(18)}  ${String(u(O,x=>x.longOpenInterestUsd+"|"+x.shortOpenInterestUsd)).padStart(9)}`);
}
