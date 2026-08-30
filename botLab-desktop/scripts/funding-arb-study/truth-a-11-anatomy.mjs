import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
// А) подтверждение аномальных часов источником; Б) анатомия заморозок в источнике.
import fs from 'fs';
const SC=STUDY_CACHE;
const OUT=STUDY_DATA;
const names=Object.keys(JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8')).perTok);
const CEIL=1e-7, APR=x=>x*3600*8760*100;
const day=t=>new Date(t*1000).toISOString().slice(0,10);
const rel=(a,b)=>a===b?0:(a===0||b===0?Infinity:Math.abs((a-b)/a));

let A={anom:0,exact:0,near:0,srcAlsoAnom:0,srcZero:0,srcSmall:0,srcBigDiff:0};
let revAnom=0;
const perTokA={};
// заморозки
const runsF=[],runsB=[];
const MIN=24;
function findRuns(arr,keyf,valf){
  const out=[];let i=0;
  while(i<arr.length){let j=i;const k=keyf(arr[i]);
    while(j+1<arr.length&&keyf(arr[j+1])===k&&Number(arr[j+1].snapshotTimestamp)-Number(arr[j].snapshotTimestamp)===3600)j++;
    const len=j-i+1;
    if(len>MIN)out.push({len,start:Number(arr[i].snapshotTimestamp),end:Number(arr[j].snapshotTimestamp),v:valf(arr[i])});
    i=j+1;}
  return out;
}
let totalHours=0, frozenHoursF=0, frozenHoursB=0, zeroFrozenF=0;
for(const t of names){
  const s=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8'));
  const f=new Map(s.funding.map(r=>[Number(r.snapshotTimestamp),[Number(r.fundingFactorPerSecondLong)/1e30,Number(r.fundingFactorPerSecondShort)/1e30]]));
  const raw=fs.readFileSync(`${SC}/${t}_1750402800_1781938800.csv`,'utf8').trim().split('\n');
  const p={anom:0,exact:0,near:0,srcAnom:0,srcZero:0};
  for(const l of raw.slice(1)){
    const q=l.split(',');const ts=Math.floor(Date.parse(q[0].replace(' ','T').replace('+00:00','Z'))/1000);
    const cl=Number(q[1]),cs=Number(q[2]);const v=f.get(ts);if(!v)continue;
    const cAn=Math.max(Math.abs(cl),Math.abs(cs))>CEIL, sAn=Math.max(Math.abs(v[0]),Math.abs(v[1]))>CEIL;
    if(sAn&&!cAn)revAnom++;
    if(!cAn)continue;
    A.anom++;p.anom++;
    const ex=(cl===v[0]&&cs===v[1]);
    const nr=Math.max(rel(cl,v[0]),rel(cs,v[1]))<1e-9;
    if(ex){A.exact++;p.exact++;} if(nr){A.near++;p.near++;}
    if(sAn){A.srcAlsoAnom++;p.srcAnom++;}
    else if(v[0]===0&&v[1]===0){A.srcZero++;p.srcZero++;}
    else A.srcSmall++;
    if(!nr&&sAn)A.srcBigDiff++;
  }
  perTokA[t]=p;
  // заморозки в источнике
  const fr=findRuns(s.funding,r=>r.fundingFactorPerSecondLong+'|'+r.fundingFactorPerSecondShort,
                    r=>[Number(r.fundingFactorPerSecondLong)/1e30,Number(r.fundingFactorPerSecondShort)/1e30]);
  const br=findRuns(s.borrowing,r=>r.borrowingFactorPerSecondLong+'|'+r.borrowingFactorPerSecondShort,
                    r=>[Number(r.borrowingFactorPerSecondLong)/1e30,Number(r.borrowingFactorPerSecondShort)/1e30]);
  fr.forEach(r=>{r.t=t;runsF.push(r);frozenHoursF+=r.len;if(r.v[0]===0&&r.v[1]===0)zeroFrozenF+=r.len;});
  br.forEach(r=>{r.t=t;runsB.push(r);frozenHoursB+=r.len;});
  totalHours+=s.funding.length;
}
console.log('=== А. аномальные часы кэша против источника ===');
console.log(JSON.stringify(A));
console.log('доля подтверждённых источником (значение почти то же, отн<1e-9):',(100*A.near/A.anom).toFixed(2)+'%');
console.log('доля побитово точных:',(100*A.exact/A.anom).toFixed(2)+'%');
console.log('источник тоже выше потолка:',(100*A.srcAlsoAnom/A.anom).toFixed(2)+'%');
console.log('аномальных в источнике, но НЕ в кэше:',revAnom);
console.log('\n=== Б. заморозки в источнике (серии >24 ч подряд, побитово равные) ===');
console.log('часов всего:',totalHours);
const nzF=runsF.filter(r=>!(r.v[0]===0&&r.v[1]===0));
console.log('серий funding:',runsF.length,'часов',frozenHoursF,(100*frozenHoursF/totalHours).toFixed(2)+'%',
  '| из них нулевых серий часов:',zeroFrozenF,'| ненулевых серий:',nzF.length,'часов',frozenHoursF-zeroFrozenF,(100*(frozenHoursF-zeroFrozenF)/totalHours).toFixed(2)+'%');
console.log('серий borrowing:',runsB.length,'часов',frozenHoursB,(100*frozenHoursB/totalHours).toFixed(2)+'%');
console.log('рынков с заморозкой funding:',new Set(runsF.map(r=>r.t)).size,'| с ненулевой заморозкой:',new Set(nzF.map(r=>r.t)).size,'| borrowing:',new Set(runsB.map(r=>r.t)).size);
const top=nzF.slice().sort((a,b)=>b.len-a.len).slice(0,15);
console.log('топ-15 ненулевых заморозок funding:');
for(const r of top)console.log(' ',r.t,r.len+'ч',day(r.start),'..',day(r.end),'f_long APR',APR(r.v[0]).toFixed(1)+'%','f_short APR',APR(r.v[1]).toFixed(1)+'%','аномально?',Math.max(Math.abs(r.v[0]),Math.abs(r.v[1]))>CEIL);
fs.writeFileSync(OUT+'/truth-a-runs.json',JSON.stringify({runsF,runsB,perTokA,A,totalHours}));
