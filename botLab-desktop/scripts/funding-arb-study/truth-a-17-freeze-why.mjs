import { DATA as STUDY_DATA } from "./paths.mjs";
// Почему стоит ставка: что ещё стоит в этот час; какая сторона аномальна; кластеры дат по рынкам.
import fs from 'fs';
const OUT=STUDY_DATA;
const names=Object.keys(JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8')).perTok);
const CEIL=1e-7, APRp=x=>x*3600*8760*100;
let anom={n:0,recvSide:0,paySide:0,bothSides:0}; let maxPay=0,maxPayT='';
let cont={b0f0:0,b0f1:0,b1f0:0,b1f1:0}; // b = менялось ли отношение балансов OI
const startH={},endH={};
const runs=JSON.parse(fs.readFileSync(OUT+'/truth-a-runs-side.json','utf8'));
for(const r of runs.filter(r=>!r.zero)){startH[r.start]=(startH[r.start]||0)+1;endH[r.end]=(endH[r.end]||0)+1;}
for(const t of names){
  const s=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8'));
  const o2=new Map(JSON.parse(fs.readFileSync(`${OUT}/truth-a-oi2/${t}.json`,'utf8')).oi.map(r=>[Number(r.snapshotTimestamp),r]));
  const F=s.funding;
  for(let k=0;k<F.length;k++){
    const r=F[k], ts=Number(r.snapshotTimestamp), b=o2.get(ts); if(!b)continue;
    const fl=Number(r.fundingFactorPerSecondLong)/1e30, fsv=Number(r.fundingFactorPerSecondShort)/1e30;
    if(Math.max(Math.abs(fl),Math.abs(fsv))>CEIL){
      anom.n++;
      const payIsLong=fl<0, payV=payIsLong?fl:fsv, recvV=payIsLong?fsv:fl;
      const pa=Math.abs(payV)>CEIL, ra=Math.abs(recvV)>CEIL;
      if(ra&&!pa)anom.recvSide++; else if(pa&&!ra)anom.paySide++; else if(pa&&ra)anom.bothSides++;
      if(Math.abs(payV)>maxPay){maxPay=Math.abs(payV);maxPayT=t+' '+new Date(ts*1000).toISOString();}
    }
    if(k>0){
      const p=F[k-1], pts=Number(p.snapshotTimestamp); if(ts-pts!==3600)continue;
      const bp=o2.get(pts); if(!bp)continue;
      const rat=x=>Number(x.longFundingBalanceOiUsd)/Number(x.shortFundingBalanceOiUsd);
      const bCh=Math.abs(rat(b)-rat(bp))>1e-12*Math.abs(rat(b));
      const fCh=(r.fundingFactorPerSecondLong!==p.fundingFactorPerSecondLong)||(r.fundingFactorPerSecondShort!==p.fundingFactorPerSecondShort);
      cont[(bCh?'b1':'b0')+(fCh?'f1':'f0')]++;
    }
  }
}
console.log('аномальных часов в источнике:',anom.n,'| аномальна только сторона-получатель:',anom.recvSide,
  (100*anom.recvSide/anom.n).toFixed(2)+'% | только сторона-плательщик:',anom.paySide,'| обе:',anom.bothSides);
console.log('максимальная ставка стороны-ПЛАТЕЛЬЩИКА за год:',maxPay.toExponential(4),'/с =',APRp(maxPay).toFixed(1)+'% годовых,',maxPayT);
console.log('\nотношение балансов OI менялось / ставка менялась:',JSON.stringify(cont));
console.log(' баланс не менялся -> ставка заморожена в',(100*cont.b0f0/(cont.b0f0+cont.b0f1)).toFixed(1)+'%');
console.log(' баланс менялся   -> ставка заморожена в',(100*cont.b1f0/(cont.b1f0+cont.b1f1)).toFixed(1)+'%');
const topS=Object.entries(startH).sort((a,b)=>b[1]-a[1]).slice(0,8);
const topE=Object.entries(endH).sort((a,b)=>b[1]-a[1]).slice(0,8);
console.log('\nсамый населённый ЧАС начала заморозки:',topS.map(([t,n])=>new Date(+t*1000).toISOString().slice(0,16)+' x'+n).join(' | '));
console.log('самый населённый ЧАС конца  заморозки:',topE.map(([t,n])=>new Date(+t*1000).toISOString().slice(0,16)+' x'+n).join(' | '));
console.log('серий с началом в один и тот же час >=5 рынков:',Object.values(startH).filter(v=>v>=5).length,'из',Object.keys(startH).length,'различных часов начала');
