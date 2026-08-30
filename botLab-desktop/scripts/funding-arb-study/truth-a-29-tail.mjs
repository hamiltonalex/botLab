import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
import fs from 'fs';
const SC=STUDY_CACHE;
const OUT=STUDY_DATA;
const names=Object.keys(JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8')).perTok);
const tc=JSON.parse(fs.readFileSync(OUT+'/truth-a-tradecount.json','utf8'));
const rel=(a,b)=>a===b?0:(a===0||b===0?Infinity:Math.abs((a-b)/a));
let lead=0,scattered=0; const bigShare=[];
for(const t of names){
  const F=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8')).funding;
  let i=0;while(i<F.length&&F[i].fundingFactorPerSecondLong==='0'&&F[i].fundingFactorPerSecondShort==='0')i++;
  const leadEnd=i?Number(F[i-1].snapshotTimestamp):-1;
  const f=new Map(F.map(r=>[Number(r.snapshotTimestamp),[Number(r.fundingFactorPerSecondLong)/1e30,Number(r.fundingFactorPerSecondShort)/1e30]]));
  let big=0,n=0;
  for(const l of fs.readFileSync(`${SC}/${t}_1750402800_1781938800.csv`,'utf8').trim().split('\n').slice(1)){
    const p=l.split(',');const ts=Math.floor(Date.parse(p[0].replace(' ','T').replace('+00:00','Z'))/1000);
    const cl=Number(p[1]),cs=Number(p[2]),v=f.get(ts); if(!v)continue; n++;
    if(v[0]===0&&v[1]===0&&!(cl===0&&cs===0)){ (ts<=leadEnd?lead++:scattered++); continue; }
    if(Math.max(rel(cl,v[0]),rel(cs,v[1]))>=1e-3)big++;
  }
  bigShare.push([Math.log(tc[t]),big/n,t]);
}
console.log('нулевые часы источника: в ведущем окне',lead,'| рассыпаны по записи',scattered);
const rank=a=>{const s=a.map((v,i)=>[v,i]).sort((x,y)=>x[0]-y[0]);const r=[];s.forEach(([,i],k)=>r[i]=k);return r;};
const rx=rank(bigShare.map(p=>p[0])),ry=rank(bigShare.map(p=>p[1]));
const m=a=>a.reduce((x,y)=>x+y,0)/a.length;const mx=m(rx),my=m(ry);
let num=0,dx=0,dy=0;for(let i=0;i<rx.length;i++){num+=(rx[i]-mx)*(ry[i]-my);dx+=(rx[i]-mx)**2;dy+=(ry[i]-my)**2;}
console.log('корреляция Спирмена (сделок за год против доли часов с разницей >=0.1%):',(num/Math.sqrt(dx*dy)).toFixed(3));
console.log('топ по доле:',bigShare.sort((a,b)=>b[1]-a[1]).slice(0,6).map(p=>p[2]+' '+(100*p[1]).toFixed(1)+'%').join(' '),'| низ:',bigShare.slice(-5).map(p=>p[2]+' '+(100*p[1]).toFixed(2)+'%').join(' '));
