import { CACHE as STUDY_CACHE } from "./paths.mjs";
// Устойчив ли сам источник СЕЙЧАС: 20 одинаковых запросов, сверка побитово.
const URL='https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const gql=async q=>{const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});const j=await r.json();if(j.errors)throw new Error(JSON.stringify(j.errors).slice(0,200));return j.data;};
const mk={AAVE:'0x1CbBa6346F110c8A5ea739ef2d1eb182990e4EB2',ADA:'0x8223bAaBEB5f10a3Ed0deb96Ff4e2Fd44dFBe9C9'};
// адрес ADA берём из scan_results
import fs from 'fs';
const sr=fs.readFileSync(STUDY_CACHE+'/_scan_results.csv','utf8').trim().split('\n');
const h=sr[0].split(','),iT=h.indexOf('token'),iM=h.indexOf('gmx_market');
for(const l of sr.slice(1)){const p=l.split(',');if(p[iT]==='ADA')mk.ADA=p[iM];}
for(const [t,m] of Object.entries(mk)){
  const q=`{ fundingRateSnapshots(limit:100, orderBy:snapshotTimestamp_ASC, where:{marketAddress_eq:"${m}", snapshotTimestamp_gte:1750489200, snapshotTimestamp_lte:1750845600}){ snapshotTimestamp fundingFactorPerSecondLong fundingFactorPerSecondShort } }`;
  const seen=new Map();
  for(let i=0;i<20;i++){const d=await gql(q);const k=JSON.stringify(d.fundingRateSnapshots);seen.set(k,(seen.get(k)||0)+1);}
  console.log(t,'различных ответов из 20:',seen.size, [...seen.values()].join('/'));
  if(seen.size>1){
    const arr=[...seen.keys()].map(k=>JSON.parse(k));
    for(let i=0;i<arr[0].length;i++){
      const vals=new Set(arr.map(a=>a[i].fundingFactorPerSecondLong));
      if(vals.size>1){console.log('  расходится час',arr[0][i].snapshotTimestamp,[...vals].join(' | '));}
    }
  }
}
