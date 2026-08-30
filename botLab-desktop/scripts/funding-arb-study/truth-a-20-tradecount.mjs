import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from 'fs';
const URL='https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const gql=async q=>{const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});const j=await r.json();if(j.errors)throw new Error(JSON.stringify(j.errors).slice(0,150));return j.data;};
const OUT=STUDY_DATA;
const A=JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8'));
const names=Object.keys(A.perTok);
const out={};
await Promise.all(names.map(async t=>{
  const d=await gql(`{ tradeActionsConnection(orderBy:id_ASC, where:{marketAddress_eq:"${A.mkt[t].market}", eventName_eq:"OrderExecuted", timestamp_gte:1750402800, timestamp_lte:1781938800}){ totalCount } }`);
  out[t]=d.tradeActionsConnection.totalCount;
}));
fs.writeFileSync(OUT+'/truth-a-tradecount.json',JSON.stringify(out));
const s=Object.entries(out).sort((a,b)=>a[1]-b[1]);
console.log('исполненных ордеров за год, по рынкам (возр.):');
console.log(s.map(([t,n])=>t+':'+n).join(' '));
console.log('сумма:',Object.values(out).reduce((a,b)=>a+b,0));
