import { DATA as STUDY_DATA } from "./paths.mjs";
// Связь заморозки со сделками: 20 рынков, почасовая таблица сопряжённости.
import fs from 'fs';
const OUT=STUDY_DATA;
const top=JSON.parse(fs.readFileSync(OUT+'/truth-a-top20.json','utf8'));
let c={t0f0:0,t0f1:0,t1f0:0,t1f1:0};
let inRun={hours:0,trades:0},outRun={hours:0,trades:0};
for(const t of top){
  const F=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8')).funding;
  const tr=JSON.parse(fs.readFileSync(`${OUT}/truth-a-trades/${t}.json`,'utf8'));
  const perHour=new Map(); for(const ts of tr){const h=Math.floor(ts/3600)*3600;perHour.set(h,(perHour.get(h)||0)+1);}
  // часы внутри заморозок >24ч
  const frozenHour=new Set(); let i=0;
  while(i<F.length){let j=i;
    while(j+1<F.length&&F[j+1].fundingFactorPerSecondLong===F[i].fundingFactorPerSecondLong&&F[j+1].fundingFactorPerSecondShort===F[i].fundingFactorPerSecondShort&&Number(F[j+1].snapshotTimestamp)-Number(F[j].snapshotTimestamp)===3600)j++;
    if(j-i+1>24)for(let k=i;k<=j;k++)frozenHour.add(Number(F[k].snapshotTimestamp));
    i=j+1;}
  for(let k=1;k<F.length;k++){
    const ts=Number(F[k].snapshotTimestamp);
    if(Number(F[k].snapshotTimestamp)-Number(F[k-1].snapshotTimestamp)!==3600)continue;
    const fCh=F[k].fundingFactorPerSecondLong!==F[k-1].fundingFactorPerSecondLong||F[k].fundingFactorPerSecondShort!==F[k-1].fundingFactorPerSecondShort;
    const n=perHour.get(ts)||0;
    c[(n?'t1':'t0')+(fCh?'f1':'f0')]++;
    if(frozenHour.has(ts)){inRun.hours++;inRun.trades+=n;}else{outRun.hours++;outRun.trades+=n;}
  }
}
const n=c.t0f0+c.t0f1+c.t1f0+c.t1f1;
console.log('20 рынков, часов:',n);
console.log('сделок в часе НЕТ: ставка стоит',c.t0f0,'меняется',c.t0f1,'=> стоит в',(100*c.t0f0/(c.t0f0+c.t0f1)).toFixed(1)+'%');
console.log('сделки ЕСТЬ:      ставка стоит',c.t1f0,'меняется',c.t1f1,'=> стоит в',(100*c.t1f0/(c.t1f0+c.t1f1)).toFixed(1)+'%');
console.log('внутри заморозок >24ч:',inRun.hours,'ч,',inRun.trades,'сделок =',(24*inRun.trades/inRun.hours).toFixed(2),'сделок/сут');
console.log('вне заморозок:        ',outRun.hours,'ч,',outRun.trades,'сделок =',(24*outRun.trades/outRun.hours).toFixed(2),'сделок/сут');
console.log('отношение активности вне/внутри:',(outRun.trades/outRun.hours)/(inRun.trades/inRun.hours));
