import {q,MAP,all,SP} from "./truth-v-lib.mjs"; import fs from "node:fs";
const YEAR=8761, full=[...all.keys()].filter(t=>all.get(t).length===YEAR);
const rows0=all.get("BTC"); const T0=rows0[0].tsHour, T1=rows0[YEAR-1].tsHour+3600;
const res=[];
for(const t of full){ const a=MAP.get(t).market;
  const d=await q(`{ tradeActionsConnection(orderBy: timestamp_ASC, first:0, where:{marketAddress_eq:"${a}", eventName_eq:"OrderExecuted", timestamp_gte:${T0}, timestamp_lt:${T1}}){ totalCount } }`);
  const n=d.tradeActionsConnection.totalCount;
  const rows=all.get(t);
  const anom=rows.filter(r=>Math.max(Math.abs(r.f_long),Math.abs(r.f_short))>1e-7).length;
  res.push({t,trades:n,perDay:n/365,anomPct:100*anom/rows.length});
}
fs.writeFileSync(`${SP}/truth-v-trades.json`,JSON.stringify(res,null,1));
res.sort((a,b)=>a.trades-b.trades);
console.log("СДЕЛОК ЗА ГОД НА РЫНКЕ GMX (OrderExecuted) против доли аномальных часов");
console.log("рынок      сделок/год  сделок/сут  часов >1e-7");
for(const r of res) console.log(`${r.t.padEnd(10)} ${String(r.trades).padStart(9)}  ${r.perDay.toFixed(1).padStart(9)}  ${r.anomPct.toFixed(2).padStart(7)}%`);
// корреляция ранга
const A=res.map(r=>r.trades), B=res.map(r=>r.anomPct);
const rk=x=>{const s=x.map((v,i)=>[v,i]).sort((p,q)=>p[0]-q[0]); const r=[];s.forEach(([,i],k)=>r[i]=k);return r;};
const ra=rk(A),rb=rk(B),n=A.length; const ma=(n-1)/2;
let num=0,da=0,db=0; for(let i=0;i<n;i++){num+=(ra[i]-ma)*(rb[i]-ma);da+=(ra[i]-ma)**2;db+=(rb[i]-ma)**2;}
console.log(`\nранговая корреляция Спирмена (сделок за год) против (доли аномальных часов): ${(num/Math.sqrt(da*db)).toFixed(3)}`);
