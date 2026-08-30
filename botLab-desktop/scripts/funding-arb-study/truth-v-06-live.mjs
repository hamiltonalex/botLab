import {q,MAP,all,SP,apr} from "./truth-v-lib.mjs"; import fs from "node:fs";
const runs=JSON.parse(fs.readFileSync(`${SP}/truth-v-runs.json`,"utf8"));
const cap=JSON.parse(fs.readFileSync(`${SP}/truth-v-cap.json`,"utf8"));
const capBy=new Map(cap.map(r=>[r.t,Number(r.maxFundingFactorPerSecondLong)/1e30]));
const top=runs.filter(r=>r.n>=48).sort((a,b)=>b.n-a.n).slice(0,60);
console.log(`серий длиной >=48ч всего: ${runs.filter(r=>r.n>=48).length}; беру ${top.length} самых длинных`);
console.log("\nтокен     часов  окно                                сделок  сд/сут   OI_long$   OI_short$  OI менялся  f_long %год");
const out=[];
for(const r of top){
  const a=MAP.get(r.t).market;
  const t0=r.ts0, t1=r.ts1+3600;
  const d=await q(`{ tradeActionsConnection(orderBy: timestamp_ASC, first:0, where:{marketAddress_eq:"${a}", eventName_eq:"OrderExecuted", timestamp_gte:${t0}, timestamp_lt:${t1}}) { totalCount } }`);
  const n=d.tradeActionsConnection.totalCount;
  // OI: берём до 200 снимков равномерно (limit ограничим 1000 и посчитаем уникальные)
  const o=await q(`{ fundingBalanceOiSnapshots(limit:1000, orderBy: snapshotTimestamp_ASC, where:{marketAddress_eq:"${a}", snapshotTimestamp_gte:${t0}, snapshotTimestamp_lt:${t1}}){ snapshotTimestamp longOpenInterestUsd shortOpenInterestUsd } }`);
  const snaps=o.fundingBalanceOiSnapshots;
  const uniq=new Set(snaps.map(s=>s.longOpenInterestUsd+"|"+s.shortOpenInterestUsd)).size;
  const L=snaps.length?Number(snaps[0].longOpenInterestUsd)/1e30:NaN, S=snaps.length?Number(snaps[0].shortOpenInterestUsd)/1e30:NaN;
  const days=(t1-t0)/86400;
  out.push({...r,trades:n,perDay:n/days,oiL:L,oiS:S,oiUniq:uniq,snaps:snaps.length});
  console.log(`${r.t.padEnd(9)} ${String(r.n).padStart(5)}  ${r.t0.slice(0,16)}..${r.t1.slice(0,16)}  ${String(n).padStart(6)}  ${(n/days).toFixed(2).padStart(6)}  ${L.toFixed(0).padStart(10)} ${S.toFixed(0).padStart(10)}  ${String(uniq).padStart(4)}/${String(snaps.length).padEnd(5)}  ${apr(r.v).toFixed(1).padStart(9)}`);
}
fs.writeFileSync(`${SP}/truth-v-live.json`,JSON.stringify(out,null,1));
const zero=out.filter(r=>r.trades===0).length, few=out.filter(r=>r.trades<=2).length;
console.log(`\nиз ${out.length} длинных серий: ${zero} с НУЛЁМ сделок, ${few} с <=2 сделками`);
console.log(`серий, где OI не менялся вовсе (1 уникальное значение): ${out.filter(r=>r.oiUniq<=1).length}`);
console.log(`серий, где OI == 0 на обеих сторонах: ${out.filter(r=>r.oiL===0&&r.oiS===0).length}`);
