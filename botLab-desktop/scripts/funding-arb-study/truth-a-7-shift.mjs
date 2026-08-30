import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
// Природа расхождения: сдвиг во времени? иная точность? иные значения?
import fs from 'fs';
const SC=STUDY_CACHE;
const OUT=STUDY_DATA;
const names=Object.keys(JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8')).perTok);
const H=3600;
const shift={}; for(let k=-3;k<=3;k++)shift[k]=0;
let rel=[],n=0,exact=0;
for(const t of names){
  const s=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8'));
  const f=new Map(s.funding.map(r=>[Number(r.snapshotTimestamp),[Number(r.fundingFactorPerSecondLong)/1e30,Number(r.fundingFactorPerSecondShort)/1e30]]));
  const raw=fs.readFileSync(`${SC}/${t}_1750402800_1781938800.csv`,'utf8').trim().split('\n');
  for(const l of raw.slice(1)){
    const p=l.split(',');const ts=Math.floor(Date.parse(p[0].replace(' ','T').replace('+00:00','Z'))/1000);
    const cl=Number(p[1]),cs=Number(p[2]); n++;
    for(let k=-3;k<=3;k++){const v=f.get(ts+k*H); if(v&&v[0]===cl&&v[1]===cs)shift[k]++;}
    const v0=f.get(ts);
    if(v0&&v0[0]===cl&&v0[1]===cs){exact++;continue;}
    if(v0&&cl!==0&&v0[0]!==0) rel.push(Math.abs((cl-v0[0])/cl));
  }
}
console.log('часов всего',n,'точных совпадений в тот же час',exact,(100*exact/n).toFixed(1)+'%');
console.log('совпадений при сдвиге на k часов:',JSON.stringify(shift));
rel.sort((a,b)=>a-b);
const q=p=>rel[Math.floor(p*(rel.length-1))].toExponential(3);
console.log('относительная разница f_long на несовпавших часах: n=',rel.length,'p1',q(0.01),'p10',q(0.1),'медиана',q(0.5),'p90',q(0.9),'p99',q(0.99),'max',q(1));
console.log('доля несовпадений с отн.разницей <1e-12:',(100*rel.filter(x=>x<1e-12).length/rel.length).toFixed(2)+'%');
console.log('доля несовпадений с отн.разницей <1e-3:',(100*rel.filter(x=>x<1e-3).length/rel.length).toFixed(2)+'%');
