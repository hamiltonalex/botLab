import { DATA as STUDY_DATA } from "./paths.mjs";
// Активность внутри заморозок по рынкам + что за сделки идут внутри.
import fs from 'fs';
const URL='https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const gql=async q=>{const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});const j=await r.json();if(j.errors)throw new Error(JSON.stringify(j.errors).slice(0,200));return j.data;};
const OUT=STUDY_DATA;
const A=JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8'));
const top=JSON.parse(fs.readFileSync(OUT+'/truth-a-top20.json','utf8'));
const frozenHours=t=>{const F=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8')).funding;
  const set=new Set();let i=0;
  while(i<F.length){let j=i;
    while(j+1<F.length&&F[j+1].fundingFactorPerSecondLong===F[i].fundingFactorPerSecondLong&&F[j+1].fundingFactorPerSecondShort===F[i].fundingFactorPerSecondShort&&Number(F[j+1].snapshotTimestamp)-Number(F[j].snapshotTimestamp)===3600)j++;
    if(j-i+1>24)for(let k=i;k<=j;k++)set.add(Number(F[k].snapshotTimestamp));i=j+1;}
  return set;};
console.log('рынок | ч в заморозке | сделок/сут внутри | сделок/сут вне');
const rows=[];
for(const t of top){
  const fz=frozenHours(t); const tr=JSON.parse(fs.readFileSync(`${OUT}/truth-a-trades/${t}.json`,'utf8'));
  let ti=0,to=0; for(const ts of tr){ (fz.has(Math.floor(ts/3600)*3600)?ti++:to++); }
  const hi=fz.size, ho=8761-hi;
  rows.push([t,hi,24*ti/hi,24*to/ho]);
  console.log(t.padEnd(9),String(hi).padStart(5),(24*ti/hi).toFixed(2).padStart(7),(24*to/ho).toFixed(2).padStart(8));
}
console.log('медиана отношения вне/внутри:',rows.map(r=>r[3]/r[2]).sort((a,b)=>a-b)[Math.floor(rows.length/2)].toFixed(2));
// что за сделки внутри заморозки BOME/PEPE/BONK
for(const t of ['BOME','PEPE','BONK']){
  const fz=frozenHours(t);
  const d=await gql(`{ tradeActions(limit:400, orderBy:timestamp_ASC, where:{marketAddress_eq:"${A.mkt[t].market}", eventName_eq:"OrderExecuted", timestamp_gte:1750402800, timestamp_lte:1781938800}){ timestamp orderType sizeDeltaUsd isFundingFeeSettle } }`);
  let inF=0,inZero=0,byType={};
  for(const r of d.tradeActions){ if(!fz.has(Math.floor(Number(r.timestamp)/3600)*3600))continue; inF++;
    if(Number(r.sizeDeltaUsd)===0)inZero++; byType[r.orderType]=(byType[r.orderType]||0)+1;}
  console.log(t,'из первых',d.tradeActions.length,'сделок внутри заморозок',inF,'из них с sizeDeltaUsd=0:',inZero,'типы:',JSON.stringify(byType));
}
