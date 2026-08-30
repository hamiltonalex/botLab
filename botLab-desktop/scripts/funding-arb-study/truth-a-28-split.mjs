import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
import fs from 'fs';
const SC=STUDY_CACHE;
const OUT=STUDY_DATA;
const names=Object.keys(JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8')).perTok);
const rel=(a,b)=>a===b?0:(a===0||b===0?Infinity:Math.abs((a-b)/a));
let k={exact:0,ulp:0,mid:0,big:0,srcZero:0,n:0}; const zeroMk=new Set(); const bigMk={};
for(const t of names){
  const f=new Map(JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8')).funding.map(r=>[Number(r.snapshotTimestamp),[Number(r.fundingFactorPerSecondLong)/1e30,Number(r.fundingFactorPerSecondShort)/1e30]]));
  for(const l of fs.readFileSync(`${SC}/${t}_1750402800_1781938800.csv`,'utf8').trim().split('\n').slice(1)){
    const p=l.split(',');const ts=Math.floor(Date.parse(p[0].replace(' ','T').replace('+00:00','Z'))/1000);
    const cl=Number(p[1]),cs=Number(p[2]),v=f.get(ts); if(!v)continue; k.n++;
    if(cl===v[0]&&cs===v[1]){k.exact++;continue;}
    if(v[0]===0&&v[1]===0){k.srcZero++;zeroMk.add(t);continue;}
    const e=Math.max(rel(cl,v[0]),rel(cs,v[1]));
    if(e<1e-12)k.ulp++; else if(e<1e-3)k.mid++; else {k.big++;bigMk[t]=(bigMk[t]||0)+1;}
  }
}
const pc=x=>(100*x/k.n).toFixed(2)+'%';
console.log('часов',k.n);
console.log('побитово равно      ',k.exact,pc(k.exact));
console.log('разница < 1e-12 (ulp)',k.ulp,pc(k.ulp));
console.log('разница 1e-12..1e-3 ',k.mid,pc(k.mid));
console.log('разница >= 1e-3     ',k.big,pc(k.big));
console.log('источник сегодня 0   ',k.srcZero,pc(k.srcZero));
console.log('рынки с нулевым окном:',[...zeroMk].sort().join(' '),'(',zeroMk.size,')');
console.log('рынки с крупной разницей (топ):',Object.entries(bigMk).sort((a,b)=>b[1]-a[1]).slice(0,12).map(x=>x[0]+':'+x[1]).join(' '));
