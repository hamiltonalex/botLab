import fs from "node:fs";
import { gql, T0, T1 } from "./truth-b-lib.mjs";
const Q=`query($a:Int!,$b:Int!,$off:Int!){ claimActions(
  where:{eventName_eq:ClaimFunding, timestamp_gte:$a, timestamp_lte:$b},
  orderBy:[timestamp_ASC,id_ASC], limit:1000, offset:$off){
  id account marketAddresses tokenAddresses tokenPrices amounts timestamp } }`;
let acc=[], a=T0, guard=0;
while(guard++<200){
  let page=[];
  for(let off=0; off<10000; off+=1000){
    const d=await gql(Q,{a,b:T1,off});
    page.push(...d.claimActions);
    if(d.claimActions.length<1000){ off=1e9; break; }
  }
  if(!page.length) break;
  acc.push(...page);
  const last=page[page.length-1].timestamp;
  process.stderr.write(`${acc.length} ${new Date(last*1000).toISOString()}\n`);
  if(page.length<10000) break;
  a=last;
}
const seen=new Set(), out=[];
for(const r of acc) if(!seen.has(r.id)){seen.add(r.id); out.push(r);}
fs.writeFileSync("truth-skept-raw/claims.json", JSON.stringify(out));
console.log("ClaimFunding уникальных", out.length);
