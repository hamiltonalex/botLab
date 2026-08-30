import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
// Где именно кэш расходится с сегодняшним источником: по месяцам и по типу расхождения.
import fs from 'fs';
const SC=STUDY_CACHE;
const OUT=STUDY_DATA;
const names=Object.keys(JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8')).perTok);
const mon=t=>new Date(t*1000).toISOString().slice(0,7);
const byMon={},kind={srcZero:0,cacheZero:0,both:0,shift:0,other:0};
const perTokFirstMism={};
for(const t of names){
  const s=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8'));
  const f=new Map(s.funding.map(r=>[Number(r.snapshotTimestamp),r]));
  const raw=fs.readFileSync(`${SC}/${t}_1750402800_1781938800.csv`,'utf8').trim().split('\n');
  const rows=raw.slice(1).map(l=>{const p=l.split(',');return {ts:Math.floor(Date.parse(p[0].replace(' ','T').replace('+00:00','Z'))/1000),fl:Number(p[1]),fs:Number(p[2])};});
  // индекс значений источника по значению для поиска сдвига
  const val2ts=new Map();
  for(const r of s.funding){const k=r.fundingFactorPerSecondLong+'|'+r.fundingFactorPerSecondShort;if(!val2ts.has(k))val2ts.set(k,Number(r.snapshotTimestamp));}
  let firstM=null,lastM=null;
  for(const r of rows){
    const sf=f.get(r.ts);const el=Number(sf.fundingFactorPerSecondLong)/1e30, es=Number(sf.fundingFactorPerSecondShort)/1e30;
    const m=mon(r.ts); byMon[m]=byMon[m]||[0,0]; byMon[m][1]++;
    if(r.fl!==el||r.fs!==es){
      byMon[m][0]++;
      if(firstM===null)firstM=r.ts; lastM=r.ts;
      if(el===0&&es===0){ if(r.fl===0&&r.fs===0)kind.both++; else kind.srcZero++; }
      else if(r.fl===0&&r.fs===0) kind.cacheZero++;
      else kind.other++;
    }
  }
  perTokFirstMism[t]=[firstM&&new Date(firstM*1000).toISOString().slice(0,10),lastM&&new Date(lastM*1000).toISOString().slice(0,10)];
}
console.log('месяц  расхождений/часов  доля');
for(const m of Object.keys(byMon).sort())console.log(m,byMon[m][0],byMon[m][1],(100*byMon[m][0]/byMon[m][1]).toFixed(1)+'%');
console.log('типы:',JSON.stringify(kind));
console.log('первый..последний час расхождения (10 имён):',JSON.stringify(Object.fromEntries(Object.entries(perTokFirstMism).slice(0,10))));
