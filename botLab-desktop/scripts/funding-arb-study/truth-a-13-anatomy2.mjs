import { DATA as STUDY_DATA } from "./paths.mjs";
// Анатомия заморозки: односторонние серии, спутники (borrow/OI/цена), уровень, кластеризация дат.
import fs from 'fs';
const OUT=STUDY_DATA;
const names=Object.keys(JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8')).perTok);
const CEIL=1e-7, APRp=x=>x*3600*8760*100, day=t=>new Date(t*1000).toISOString().slice(0,10);
const MIN=24;
let tot={hours:0};
const side={long:{runs:0,hours:0,mk:new Set()},short:{runs:0,hours:0,mk:new Set()}};
const allRuns=[];
let sat={hours:0,bChanged:0,oiChanged:0,priceChanged:0,oiMissing:0};
let lvl={anomHours:0,normHours:0,zeroHours:0};
const startDays={},endDays={};
for(const t of names){
  const s=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8'));
  const oi=JSON.parse(fs.readFileSync(`${OUT}/truth-a-oi/${t}.json`,'utf8'));
  const O=new Map(oi.oi.map(r=>[Number(r.snapshotTimestamp),r]));
  const B=new Map(s.borrowing.map(r=>[Number(r.snapshotTimestamp),r.borrowingFactorPerSecondLong+'|'+r.borrowingFactorPerSecondShort]));
  const F=s.funding; tot.hours+=F.length;
  for(const key of ['Long','Short']){
    const fld='fundingFactorPerSecond'+key; const sd=key==='Long'?'long':'short';
    let i=0;
    while(i<F.length){let j=i;const v=F[i][fld];
      while(j+1<F.length&&F[j+1][fld]===v&&Number(F[j+1].snapshotTimestamp)-Number(F[j].snapshotTimestamp)===3600)j++;
      const len=j-i+1;
      if(len>MIN){
        side[sd].runs++;side[sd].hours+=len;side[sd].mk.add(t);
        const num=Number(v)/1e30;
        const r={t,side:sd,len,start:Number(F[i].snapshotTimestamp),end:Number(F[j].snapshotTimestamp),v:num,zero:v==='0',anom:Math.abs(num)>CEIL};
        allRuns.push(r);
        startDays[day(r.start)]=(startDays[day(r.start)]||0)+1; endDays[day(r.end)]=(endDays[day(r.end)]||0)+1;
        if(v==='0')lvl.zeroHours+=len; else if(r.anom)lvl.anomHours+=len; else lvl.normHours+=len;
        if(v!=='0'){ // спутники только для ненулевых заморозок
          for(let k=i+1;k<=j;k++){
            const ts=Number(F[k].snapshotTimestamp), pv=Number(F[k-1].snapshotTimestamp);
            sat.hours++;
            if(B.get(ts)!==B.get(pv))sat.bChanged++;
            const a=O.get(ts),b=O.get(pv);
            if(!a||!b){sat.oiMissing++;continue;}
            if(a.longOpenInterestUsd!==b.longOpenInterestUsd||a.shortOpenInterestUsd!==b.shortOpenInterestUsd)sat.oiChanged++;
            if(a.indexTokenMinPrice!==b.indexTokenMinPrice)sat.priceChanged++;
          }
        }
      }
      i=j+1;}
  }
}
console.log('часов всего:',tot.hours);
for(const k of ['long','short'])console.log(`заморозки f_${k}: серий ${side[k].runs}, часов ${side[k].hours} (${(100*side[k].hours/tot.hours).toFixed(2)}%), рынков ${side[k].mk.size}`);
const nz=allRuns.filter(r=>!r.zero);
console.log('ненулевых серий:',nz.length,'часов',nz.reduce((a,b)=>a+b.len,0),'рынков',new Set(nz.map(r=>r.t)).size);
console.log('часы заморозки по уровню: нулевые',lvl.zeroHours,'аномальные(|f|>1e-7)',lvl.anomHours,'обычные',lvl.normHours,
  '=> доля аномальных среди ненулевых заморозок:',(100*lvl.anomHours/(lvl.anomHours+lvl.normHours)).toFixed(1)+'%');
console.log('\nспутники внутри ненулевых заморозок funding (часов',sat.hours,'):');
console.log('  borrow изменился:',sat.bChanged,(100*sat.bChanged/sat.hours).toFixed(1)+'%');
console.log('  OI изменился:',sat.oiChanged,(100*sat.oiChanged/sat.hours).toFixed(1)+'%','нет OI-снимка:',sat.oiMissing);
console.log('  цена индекса изменилась:',sat.priceChanged,(100*sat.priceChanged/sat.hours).toFixed(1)+'%');
const topS=Object.entries(startDays).sort((a,b)=>b[1]-a[1]).slice(0,10);
const topE=Object.entries(endDays).sort((a,b)=>b[1]-a[1]).slice(0,10);
console.log('\nсамые частые даты НАЧАЛА заморозки:',topS.map(x=>x[0]+':'+x[1]).join(' '));
console.log('самые частые даты КОНЦА  заморозки:',topE.map(x=>x[0]+':'+x[1]).join(' '));
console.log('всего различных дат начала:',Object.keys(startDays).length,'при',allRuns.length,'сериях');
fs.writeFileSync(OUT+'/truth-a-runs-side.json',JSON.stringify(allRuns));
