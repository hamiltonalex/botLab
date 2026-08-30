import { DATA as STUDY_DATA } from "./paths.mjs";
// Метки исполненных ордеров по 20 самым «залипающим» рынкам.
import fs from 'fs';
const URL='https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const gql=async q=>{for(let i=0;i<6;i++){try{const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});const j=await r.json();if(j.errors)throw new Error(JSON.stringify(j.errors).slice(0,150));return j.data;}catch(e){if(i===5)throw e;await new Promise(s=>setTimeout(s,1000*(i+1)));}}};
const OUT=STUDY_DATA;
const A=JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8'));
const names=Object.keys(A.perTok);
// доля неизменных часов
const fr={};
for(const t of names){const F=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8')).funding;
  let z=0;for(let k=1;k<F.length;k++)if(F[k].fundingFactorPerSecondLong===F[k-1].fundingFactorPerSecondLong&&F[k].fundingFactorPerSecondShort===F[k-1].fundingFactorPerSecondShort)z++;
  fr[t]=z/(F.length-1);}
const top=Object.entries(fr).sort((a,b)=>b[1]-a[1]).slice(0,20).map(x=>x[0]);
console.log('20 самых залипающих:',top.map(t=>t+' '+(100*fr[t]).toFixed(0)+'%').join(', '));
fs.mkdirSync(OUT+'/truth-a-trades',{recursive:true});
for(const t of top){
  const p=`${OUT}/truth-a-trades/${t}.json`; if(fs.existsSync(p))continue;
  const rows=[]; let off=0;
  for(;;){
    const d=await gql(`{ tradeActions(limit:1000, offset:${off}, orderBy:timestamp_ASC, where:{marketAddress_eq:"${A.mkt[t].market}", eventName_eq:"OrderExecuted", timestamp_gte:1750402800, timestamp_lte:1781938800}){ timestamp sizeDeltaUsd } }`);
    const b=d.tradeActions; if(!b.length)break; rows.push(...b.map(r=>Number(r.timestamp))); off+=1000; if(b.length<1000)break;
  }
  fs.writeFileSync(p,JSON.stringify(rows)); console.log(t,rows.length);
}
fs.writeFileSync(OUT+'/truth-a-top20.json',JSON.stringify(top));
