import fs from "node:fs";
import { gql, scan, T0, T1 } from "./truth-b-lib.mjs";
const S = scan();
const T = JSON.parse(fs.readFileSync("cap63.json","utf8")).map(c=>c.t);
const Q = `query($m:String!,$a:Int!,$b:Int!,$off:Int!){ fundingBalanceOiSnapshots(
  where:{marketAddress_eq:$m, snapshotTimestamp_gte:$a, snapshotTimestamp_lte:$b},
  orderBy:[snapshotTimestamp_ASC], limit:1000, offset:$off){ snapshotTimestamp longOpenInterestUsd shortOpenInterestUsd } }`;
for (const t of T) {
  const p=`truth-b-raw/oi_${t}.json`; if(fs.existsSync(p)) continue;
  const m=S.get(t)?.market; if(!m){console.log(t,"нет рынка");continue;}
  const acc=[]; for(let off=0;;off+=1000){const d=await gql(Q,{m,a:T0,b:T1,off});acc.push(...d.fundingBalanceOiSnapshots);if(d.fundingBalanceOiSnapshots.length<1000)break;}
  fs.writeFileSync(p,JSON.stringify(acc)); console.log(t,acc.length);
}
console.log("ГОТОВО");
