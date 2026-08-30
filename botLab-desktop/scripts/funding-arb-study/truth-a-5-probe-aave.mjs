const URL='https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const gql=async q=>{const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});const j=await r.json();if(j.errors)console.log('ERR',JSON.stringify(j.errors).slice(0,200));return j.data;};
let d=await gql(`{ fundingRateSnapshots(limit:5, orderBy:snapshotTimestamp_ASC, where:{marketAddress_eq:"0x1CbBa6346F110c8A5ea739ef2d1eb182990e4EB2", snapshotTimestamp_gte:1750402800, snapshotTimestamp_lte:1750413600}){ id snapshotTimestamp fundingFactorPerSecondLong fundingFactorPerSecondShort } }`);
console.log('точечно AAVE-USDC:',JSON.stringify(d.fundingRateSnapshots));
d=await gql(`{ fundingRateSnapshots(limit:200, where:{snapshotTimestamp_eq:1750402800}){ marketAddress fundingFactorPerSecondLong fundingFactorPerSecondShort } }`);
console.log('рынков в этот час:',d.fundingRateSnapshots.length);
const target=3.591628918020297e-08;
for(const r of d.fundingRateSnapshots){
  const fl=Number(r.fundingFactorPerSecondLong)/1e30, fs=Number(r.fundingFactorPerSecondShort)/1e30;
  if(fl===target||fs===target) console.log('НАЙДЕНО совпадение с кэшем AAVE:',r.marketAddress,fl,fs);
}
console.log('первые 5:',d.fundingRateSnapshots.slice(0,5).map(r=>r.marketAddress+' '+(Number(r.fundingFactorPerSecondLong)/1e30)).join('\n'));
