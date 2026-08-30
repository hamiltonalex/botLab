import { DATA as STUDY_DATA } from "./paths.mjs";
// Перезапрос первоисточника: funding + borrowing снимки за всё окно по 63 рынкам.
import fs from 'fs';
const URL='https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const OUT=STUDY_DATA;
const DIR=OUT+'/truth-a-src';
fs.mkdirSync(DIR,{recursive:true});
const A=JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8'));
const names=Object.keys(A.perTok);
const START=1750402800, END=1781938800;
async function gql(q){
  for(let i=0;i<6;i++){
    try{
      const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});
      if(!r.ok) throw new Error('HTTP '+r.status);
      const j=await r.json();
      if(j.errors) throw new Error('GQL '+JSON.stringify(j.errors).slice(0,200));
      return j.data;
    }catch(e){ if(i===5) throw e; await new Promise(s=>setTimeout(s,1200*(i+1))); }
  }
}
async function page(entity,addrField,market,fields){
  const rows=[]; let cursor=START-1;
  // повторяем пагинацию сборщика кэша: limit 1000, snapshotTimestamp_gt cursor
  for(;;){
    const q=`{ ${entity}(limit: 1000, orderBy: snapshotTimestamp_ASC,
      where: { ${addrField}_eq: "${market}", snapshotTimestamp_gt: ${cursor}, snapshotTimestamp_lte: ${END} })
      { snapshotTimestamp ${fields} } }`;
    const b=(await gql(q))[entity];
    if(!b.length) break;
    rows.push(...b);
    cursor=b[b.length-1].snapshotTimestamp;
    if(b.length<1000) break;
  }
  return rows;
}
const q=[...names];
let done=0;
async function worker(){
  for(;;){
    const t=q.shift(); if(!t) return;
    const p=`${DIR}/${t}.json`;
    if(fs.existsSync(p)){done++;continue;}
    const m=A.mkt[t].market;
    const f=await page('fundingRateSnapshots','marketAddress',m,'fundingFactorPerSecondLong fundingFactorPerSecondShort');
    const b=await page('borrowingRateSnapshots','address',m,'borrowingFactorPerSecondLong borrowingFactorPerSecondShort');
    fs.writeFileSync(p,JSON.stringify({token:t,market:m,funding:f,borrowing:b}));
    done++;
    console.log(`${done}/${names.length} ${t} funding=${f.length} borrow=${b.length}`);
  }
}
await Promise.all([...Array(5)].map(worker));
console.log('готово');
