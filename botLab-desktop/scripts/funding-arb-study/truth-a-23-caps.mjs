import { DATA as STUDY_DATA } from "./paths.mjs";
// Не упирается ли замороженная ставка в потолок протокола.
import fs from 'fs';
const URL='https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const gql=async q=>{const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});const j=await r.json();if(j.errors)throw new Error(JSON.stringify(j.errors).slice(0,200));return j.data;};
const OUT=STUDY_DATA;
const A=JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8'));
const names=Object.keys(A.perTok);
const info={};
for(let i=0;i<names.length;i+=8){
  const chunk=names.slice(i,i+8);
  const parts=chunk.map((t,k)=>`m${k}: marketInfos(limit:1, where:{marketTokenAddress_eq:"${A.mkt[t].market}"}){ maxFundingFactorPerSecondLong maxFundingFactorPerSecondShort minFundingFactorPerSecondLong minFundingFactorPerSecondShort fundingIncreaseFactorPerSecond fundingDecreaseFactorPerSecond fundingFactor fundingExponentFactor thresholdForStableFunding }`).join('\n');
  const d=await gql(`{ ${parts} }`);
  chunk.forEach((t,k)=>{info[t]=d['m'+k][0];});
}
fs.writeFileSync(OUT+'/truth-a-marketinfo.json',JSON.stringify(info));
const S=1e30, APR=x=>x*3600*8760*100;
const inc=Object.entries(info).filter(([,v])=>v&&Number(v.fundingIncreaseFactorPerSecond)>0).length;
console.log('рынков с динамической моделью (fundingIncreaseFactorPerSecond>0):',inc,'из',Object.keys(info).length);
const caps=new Map();
for(const [t,v] of Object.entries(info)){if(!v)continue;const k=v.maxFundingFactorPerSecondLong+'/'+v.maxFundingFactorPerSecondShort;caps.set(k,(caps.get(k)||0)+1);}
console.log('потолки maxFundingFactorPerSecond (значение -> число рынков):');
for(const [k,n] of [...caps].sort((a,b)=>b[1]-a[1]))console.log('  ',k.split('/').map(x=>APR(Number(x)/S).toFixed(1)+'%').join(' / '),'->',n);
// сколько замороженных часов стоит ровно на потолке
const runs=JSON.parse(fs.readFileSync(OUT+'/truth-a-runs-side.json','utf8'));
let atCap=0,atCapH=0,notCap=0,notCapH=0;
for(const r of runs){ if(r.zero)continue; const v=info[r.t]; if(!v)continue;
  const cap=Number(r.side==='long'?v.maxFundingFactorPerSecondLong:v.maxFundingFactorPerSecondShort)/S;
  if(Math.abs(Math.abs(r.v)-cap)/cap<1e-9){atCap++;atCapH+=r.len;}else{notCap++;notCapH+=r.len;}}
console.log('ненулевых заморозок ровно на потолке:',atCap,'серий,',atCapH,'ч; НЕ на потолке:',notCap,'серий,',notCapH,'ч');
// сколько ВСЕХ часов стоит на потолке по стороне-плательщику
let payAtCap=0,payN=0;
for(const t of names){const F=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8')).funding;const v=info[t];if(!v)continue;
 for(const r of F){const fl=Number(r.fundingFactorPerSecondLong)/S,fs_=Number(r.fundingFactorPerSecondShort)/S;
  if(!fl||!fs_||Math.sign(fl)===Math.sign(fs_))continue; payN++;
  const payIsLong=fl<0; const pv=Math.abs(payIsLong?fl:fs_);
  const cap=Number(payIsLong?v.maxFundingFactorPerSecondLong:v.maxFundingFactorPerSecondShort)/S;
  if(cap&&Math.abs(pv-cap)/cap<1e-9)payAtCap++;}}
console.log('часов, где ставка ПЛАТЕЛЬЩИКА стоит ровно на потолке:',payAtCap,'из',payN,(100*payAtCap/payN).toFixed(1)+'%');
