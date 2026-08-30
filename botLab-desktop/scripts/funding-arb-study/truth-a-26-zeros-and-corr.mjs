import { DATA as STUDY_DATA } from "./paths.mjs";
// (1) нулевые окна сегодняшнего источника: живой ли там рынок; (2) связь заморозки с активностью рынка.
import fs from 'fs';
const URL='https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const gql=async q=>{const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});const j=await r.json();if(j.errors)throw new Error(JSON.stringify(j.errors).slice(0,200));return j.data;};
const OUT=STUDY_DATA;
const A=JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8'));
const names=Object.keys(A.perTok);
const tc=JSON.parse(fs.readFileSync(OUT+'/truth-a-tradecount.json','utf8'));
// (1)
console.log('=== нулевые окна funding в сегодняшнем источнике ===');
for(const t of ['AAVE','OP','ORDI','TAO']){
  const F=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8')).funding;
  const O=new Map(JSON.parse(fs.readFileSync(`${OUT}/truth-a-oi/${t}.json`,'utf8')).oi.map(r=>[Number(r.snapshotTimestamp),r]));
  let i=0;while(i<F.length&&F[i].fundingFactorPerSecondLong==='0'&&F[i].fundingFactorPerSecondShort==='0')i++;
  if(!i){console.log(t,'нулевого окна нет');continue;}
  const s=Number(F[0].snapshotTimestamp), e=Number(F[i-1].snapshotTimestamp);
  let bothOi=0,anyOi=0;
  for(let k=0;k<i;k++){const o=O.get(Number(F[k].snapshotTimestamp));if(!o)continue;
    const L=Number(o.longOpenInterestUsd)/1e30,S=Number(o.shortOpenInterestUsd)/1e30;
    if(L>0&&S>0)bothOi++; if(L>0||S>0)anyOi++;}
  const d=await gql(`{ tradeActionsConnection(orderBy:id_ASC, where:{marketAddress_eq:"${A.mkt[t].market}", eventName_eq:"OrderExecuted", timestamp_gte:${s}, timestamp_lte:${e}}){ totalCount } }`);
  console.log(t,'нулевых часов',i,new Date(s*1000).toISOString().slice(0,10),'..',new Date(e*1000).toISOString().slice(0,10),
    '| часов с OI по обе стороны:',bothOi,'| с любым OI:',anyOi,'| исполненных ордеров в окне:',d.tradeActionsConnection.totalCount);
}
// (2)
console.log('\n=== заморозка против активности рынка (63 рынка) ===');
const pts=[];
for(const t of names){const F=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8')).funding;
  let z=0;for(let k=1;k<F.length;k++)if(F[k].fundingFactorPerSecondLong===F[k-1].fundingFactorPerSecondLong&&F[k].fundingFactorPerSecondShort===F[k-1].fundingFactorPerSecondShort)z++;
  pts.push([Math.log(tc[t]),z/(F.length-1),t]);}
const rank=a=>{const s=a.map((v,i)=>[v,i]).sort((x,y)=>x[0]-y[0]);const r=[];s.forEach(([,i],k)=>r[i]=k);return r;};
const rx=rank(pts.map(p=>p[0])),ry=rank(pts.map(p=>p[1]));
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const mx=mean(rx),my=mean(ry);
let num=0,dx=0,dy=0;for(let i=0;i<rx.length;i++){num+=(rx[i]-mx)*(ry[i]-my);dx+=(rx[i]-mx)**2;dy+=(ry[i]-my)**2;}
console.log('корреляция Спирмена (число сделок за год против доли стоячих часов):',(num/Math.sqrt(dx*dy)).toFixed(3));
console.log('примеры:',pts.sort((a,b)=>a[1]-b[1]).slice(0,4).map(p=>p[2]+' '+(100*p[1]).toFixed(0)+'% при '+tc[p[2]]+' сделок').join(' | '),
  '||',pts.slice(-4).map(p=>p[2]+' '+(100*p[1]).toFixed(0)+'% при '+tc[p[2]]+' сделок').join(' | '));
