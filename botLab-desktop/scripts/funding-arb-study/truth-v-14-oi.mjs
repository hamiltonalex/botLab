import {q,MAP,all,SP} from "./truth-v-lib.mjs"; import fs from "node:fs";
const YEAR=8761, full=[...all.keys()].filter(t=>all.get(t).length===YEAR);
const out={};
for(const t of full){
  const a=MAP.get(t).market, rows=all.get(t);
  const t0=rows[0].tsHour, t1=rows[rows.length-1].tsHour+3600;
  let cur=t0, got=[];
  while(cur<t1){
    const d=await q(`{ fundingBalanceOiSnapshots(limit:1000, orderBy: snapshotTimestamp_ASC, where:{marketAddress_eq:"${a}", snapshotTimestamp_gte:${cur}, snapshotTimestamp_lt:${t1}}){ snapshotTimestamp longOpenInterestUsd shortOpenInterestUsd } }`);
    const s=d.fundingBalanceOiSnapshots; if(!s.length) break;
    for(const x of s) got.push([x.snapshotTimestamp, Number(x.longOpenInterestUsd)/1e30, Number(x.shortOpenInterestUsd)/1e30]);
    cur=s[s.length-1].snapshotTimestamp+1; if(s.length<1000) break;
  }
  out[t]=got; process.stderr.write(`${t}:${got.length} `);
}
fs.writeFileSync(`${SP}/truth-v-oi.json`,JSON.stringify(out));
console.log("\nготово", Object.keys(out).length);
