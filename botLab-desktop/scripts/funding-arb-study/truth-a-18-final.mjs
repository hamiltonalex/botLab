import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
// Границы с допуском, глобальные стойки индексатора, распределение длин заморозок, BOME.
import fs from 'fs';
const SC=STUDY_CACHE;
const OUT=STUDY_DATA;
const names=Object.keys(JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8')).perTok);
const TOL=1e-9, rel=(a,b)=>a===b?0:(a===0||b===0?Infinity:Math.abs((a-b)/a));
let bnd={first:0,last:0,pageN:0,pageOk:0,firstOk:0,lastOk:0};
let all={n:0,ok:0,exact:0};
const frozenPerHour=new Map(); // ts -> число рынков с неизменной ставкой
const perMarketFrozen={};
for(const t of names){
  const s=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8'));
  const F=s.funding, f=new Map(F.map(r=>[Number(r.snapshotTimestamp),[Number(r.fundingFactorPerSecondLong)/1e30,Number(r.fundingFactorPerSecondShort)/1e30]]));
  const pageTs=new Set(); F.forEach((r,i)=>{if(i%1000===0||i%1000===999)pageTs.add(Number(r.snapshotTimestamp));});
  const raw=fs.readFileSync(`${SC}/${t}_1750402800_1781938800.csv`,'utf8').trim().split('\n').slice(1);
  raw.forEach((l,idx)=>{
    const p=l.split(',');const ts=Math.floor(Date.parse(p[0].replace(' ','T').replace('+00:00','Z'))/1000);
    const cl=Number(p[1]),cs=Number(p[2]);const v=f.get(ts);if(!v)return;
    const ok=Math.max(rel(cl,v[0]),rel(cs,v[1]))<TOL, ex=(cl===v[0]&&cs===v[1]);
    all.n++; if(ok)all.ok++; if(ex)all.exact++;
    if(idx===0){bnd.first++;if(ok)bnd.firstOk++;}
    if(idx===raw.length-1){bnd.last++;if(ok)bnd.lastOk++;}
    if(pageTs.has(ts)){bnd.pageN++;if(ok)bnd.pageOk++;}
  });
  let fz=0;
  for(let k=1;k<F.length;k++){
    if(Number(F[k].snapshotTimestamp)-Number(F[k-1].snapshotTimestamp)!==3600)continue;
    const same=F[k].fundingFactorPerSecondLong===F[k-1].fundingFactorPerSecondLong&&F[k].fundingFactorPerSecondShort===F[k-1].fundingFactorPerSecondShort;
    if(same){fz++;const ts=Number(F[k].snapshotTimestamp);frozenPerHour.set(ts,(frozenPerHour.get(ts)||0)+1);}
  }
  perMarketFrozen[t]=100*fz/(F.length-1);
}
console.log('сверка кэша с источником, допуск отн<1e-9: часов',all.n,'совпало',all.ok,(100*all.ok/all.n).toFixed(2)+'%; побитово',(100*all.exact/all.n).toFixed(2)+'%');
console.log('границы: первый час',bnd.firstOk+'/'+bnd.first,'последний час',bnd.lastOk+'/'+bnd.last,'стыки страниц пагинации',bnd.pageOk+'/'+bnd.pageN);
const hh=[...frozenPerHour.entries()].sort((a,b)=>b[1]-a[1]);
console.log('\nчасы, где ставка стоит сразу у многих рынков (из 63): топ',hh.slice(0,6).map(([t,n])=>new Date(+t*1000).toISOString().slice(0,16)+' x'+n).join(' | '));
console.log('часов, где заморожено >=50 рынков:',hh.filter(x=>x[1]>=50).length,'; >=40:',hh.filter(x=>x[1]>=40).length,'; всего часов',frozenPerHour.size);
const vals=[...frozenPerHour.values()];
console.log('среднее число замороженных рынков в час:',(vals.reduce((a,b)=>a+b,0)/8760).toFixed(1));
const pm=Object.entries(perMarketFrozen).sort((a,b)=>b[1]-a[1]);
console.log('\nдоля часов с неизменной ставкой, по рынкам: топ-8',pm.slice(0,8).map(([t,v])=>t+' '+v.toFixed(0)+'%').join(', '));
console.log('низ-8',pm.slice(-8).map(([t,v])=>t+' '+v.toFixed(0)+'%').join(', '));
// BOME: серия f_long
const bs=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/BOME.json`,'utf8')).funding;
let best={len:0};let i=0;
while(i<bs.length){let j=i;while(j+1<bs.length&&bs[j+1].fundingFactorPerSecondLong===bs[i].fundingFactorPerSecondLong)j++;
  if(j-i+1>best.len)best={len:j-i+1,v:bs[i].fundingFactorPerSecondLong,s:bs[i].snapshotTimestamp,e:bs[j].snapshotTimestamp};i=j+1;}
console.log('\nBOME самая длинная серия f_long:',best.len,'ч',new Date(best.s*1000).toISOString(),'..',new Date(best.e*1000).toISOString(),'знач',Number(best.v)/1e30);
