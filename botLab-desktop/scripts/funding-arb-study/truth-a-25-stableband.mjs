import { DATA as STUDY_DATA } from "./paths.mjs";
// Гипотеза: заморозка = «стабильная полоса» динамического funding в GMX v2.
import fs from 'fs';
const OUT=STUDY_DATA;
const info=JSON.parse(fs.readFileSync(OUT+'/truth-a-marketinfo.json','utf8'));
const names=Object.keys(info);
const S=1e30;
const th=[...new Set(names.map(t=>Number(info[t].thresholdForStableFunding)/S))];
console.log('thresholdForStableFunding (доли):',th.map(x=>x.toFixed(4)).join(' '));
console.log('fundingIncreaseFactorPerSecond, пример:',Number(info[names[0]].fundingIncreaseFactorPerSecond)/S);
let bins={}; // дисбаланс -> заморожен ли
const B=x=>x<0.005?'<0.5%':x<0.02?'0.5-2%':x<0.05?'2-5%':x<0.1?'5-10%':x<0.25?'10-25%':x<0.5?'25-50%':'>50%';
for(const t of names){
  const F=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8')).funding;
  const O=new Map(JSON.parse(fs.readFileSync(`${OUT}/truth-a-oi2/${t}.json`,'utf8')).oi.map(r=>[Number(r.snapshotTimestamp),r]));
  for(let k=1;k<F.length;k++){
    const ts=Number(F[k].snapshotTimestamp); if(ts-Number(F[k-1].snapshotTimestamp)!==3600)continue;
    const o=O.get(ts); if(!o)continue;
    const L=Number(o.longFundingBalanceOiUsd),Sh=Number(o.shortFundingBalanceOiUsd);
    if(!(L+Sh))continue;
    const imb=Math.abs(L-Sh)/(L+Sh);
    const fCh=F[k].fundingFactorPerSecondLong!==F[k-1].fundingFactorPerSecondLong||F[k].fundingFactorPerSecondShort!==F[k-1].fundingFactorPerSecondShort;
    const b=B(imb); bins[b]=bins[b]||[0,0]; bins[b][fCh?1:0]++;
  }
}
console.log('\nдисбаланс OI | часов со стоячей ставкой | с меняющейся | доля стоячих');
for(const k of ['<0.5%','0.5-2%','2-5%','5-10%','10-25%','25-50%','>50%']){const v=bins[k];if(!v)continue;
  console.log(k.padEnd(8),String(v[0]).padStart(7),String(v[1]).padStart(7),(100*v[0]/(v[0]+v[1])).toFixed(1)+'%');}
