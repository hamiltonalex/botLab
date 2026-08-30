import { CACHE as STUDY_CACHE } from "./paths.mjs";
// Не перепутал ли сборщик рынок: сверяем ранний кусок кэша со ВСЕМИ рынками того же тикера.
import fs from 'fs';
const URL='https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const gql=async q=>{const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});const j=await r.json();if(j.errors)throw new Error(JSON.stringify(j.errors).slice(0,200));return j.data;};
const SC=STUDY_CACHE;
const mkts=await (await fetch('https://arbitrum-api.gmxinfra.io/markets')).json();
const list=(mkts.markets||mkts);
for(const tkr of ['AAVE','OP','PEPE','GMX']){
  const cand=list.filter(m=>m.name&&m.name.startsWith(tkr+'/USD'));
  const raw=fs.readFileSync(`${SC}/${tkr}_1750402800_1781938800.csv`,'utf8').trim().split('\n');
  const first=raw.slice(1,25).map(l=>{const p=l.split(',');return [Math.floor(Date.parse(p[0].replace(' ','T').replace('+00:00','Z'))/1000),Number(p[1]),Number(p[2])];});
  console.log('###',tkr,'рынков-кандидатов:',cand.length, cand.map(m=>m.name+' '+m.marketToken+' listing='+(m.listingDate||'').slice(0,10)).join(' ; '));
  for(const m of cand){
    const d=await gql(`{ fundingRateSnapshots(limit:30, orderBy:snapshotTimestamp_ASC, where:{marketAddress_eq:"${m.marketToken}", snapshotTimestamp_gte:${first[0][0]}, snapshotTimestamp_lte:${first[first.length-1][0]}}){ snapshotTimestamp fundingFactorPerSecondLong fundingFactorPerSecondShort } }`);
    const f=new Map(d.fundingRateSnapshots.map(r=>[Number(r.snapshotTimestamp),[Number(r.fundingFactorPerSecondLong)/1e30,Number(r.fundingFactorPerSecondShort)/1e30]]));
    let eq=0,near=0,have=0;
    for(const [ts,cl,cs] of first){const v=f.get(ts);if(!v)continue;have++;
      if(v[0]===cl&&v[1]===cs)eq++; else if(cl&&v[0]&&Math.abs((cl-v[0])/cl)<1e-9)near++;}
    console.log('   ',m.marketToken,'снимков',have,'точно',eq,'почти',near);
  }
}
