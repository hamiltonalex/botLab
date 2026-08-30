import { DATA as STUDY_DATA } from "./paths.mjs";
// Механика: связь заморозки с отсутствием сделок (OI), и происхождение аномальной величины (отношение OI).
import fs from 'fs';
const OUT=STUDY_DATA;
const names=Object.keys(JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8')).perTok);
const CEIL=1e-7;
// таблица сопряжённости: менялся ли funding против менялся ли OI (по часу)
let c={oi0f0:0,oi0f1:0,oi1f0:0,oi1f1:0};
// проверка отношения: f_short/f_long == -longOI/shortOI ?
const ratios=[]; let ratioOk=0,ratioN=0;
const anomOiRatio=[];
for(const t of names){
  const s=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8'));
  const oi=JSON.parse(fs.readFileSync(`${OUT}/truth-a-oi/${t}.json`,'utf8'));
  const O=new Map(oi.oi.map(r=>[Number(r.snapshotTimestamp),r]));
  const F=s.funding;
  for(let k=1;k<F.length;k++){
    const ts=Number(F[k].snapshotTimestamp),pv=Number(F[k-1].snapshotTimestamp);
    if(ts-pv!==3600)continue;
    const a=O.get(ts),b=O.get(pv); if(!a||!b)continue;
    const fCh=(F[k].fundingFactorPerSecondLong!==F[k-1].fundingFactorPerSecondLong)||(F[k].fundingFactorPerSecondShort!==F[k-1].fundingFactorPerSecondShort);
    const oCh=(a.longOpenInterestUsd!==b.longOpenInterestUsd)||(a.shortOpenInterestUsd!==b.shortOpenInterestUsd);
    c[(oCh?'oi1':'oi0')+(fCh?'f1':'f0')]++;
  }
  for(const r of F){
    const ts=Number(r.snapshotTimestamp),o=O.get(ts); if(!o)continue;
    const fl=Number(r.fundingFactorPerSecondLong)/1e30, fsv=Number(r.fundingFactorPerSecondShort)/1e30;
    const L=Number(o.longOpenInterestUsd)/1e30, S=Number(o.shortOpenInterestUsd)/1e30;
    if(!fl||!fsv||!L||!S)continue;
    if(Math.sign(fl)===Math.sign(fsv))continue; // одна сторона платит, другая получает
    const pred = fl<0 ? -(L/S) : -(S/L); // модуль отношения ставок = отношение OI плательщика к получателю
    const act = fl<0 ? fsv/fl : fl/fsv;
    ratioN++; const err=Math.abs((Math.abs(act)-Math.abs(fl<0?L/S:S/L))/Math.abs(act));
    if(err<0.01)ratioOk++;
    if(Math.max(Math.abs(fl),Math.abs(fsv))>CEIL) anomOiRatio.push({t,ts,oiRatio:fl<0?L/S:S/L,err});
  }
}
const n=c.oi0f0+c.oi0f1+c.oi1f0+c.oi1f1;
console.log('пар часов:',n);
console.log('OI не менялся: funding не менялся',c.oi0f0,'менялся',c.oi0f1,'=> заморожен в',(100*c.oi0f0/(c.oi0f0+c.oi0f1)).toFixed(1)+'% таких часов');
console.log('OI менялся:   funding не менялся',c.oi1f0,'менялся',c.oi1f1,'=> заморожен в',(100*c.oi1f0/(c.oi1f0+c.oi1f1)).toFixed(1)+'% таких часов');
console.log('\nотношение ставок против отношения OI: проверено',ratioN,'совпало в пределах 1%:',ratioOk,(100*ratioOk/ratioN).toFixed(1)+'%');
const a=anomOiRatio.filter(x=>x.err<0.01);
console.log('аномальные часы с проверенным отношением:',a.length,'из',anomOiRatio.length);
const rs=anomOiRatio.map(x=>x.oiRatio).sort((x,y)=>x-y);
const q=p=>rs[Math.floor(p*(rs.length-1))].toExponential(2);
console.log('отношение OI плательщик/получатель в аномальные часы: p10',q(0.1),'медиана',q(0.5),'p90',q(0.9),'max',q(1));
