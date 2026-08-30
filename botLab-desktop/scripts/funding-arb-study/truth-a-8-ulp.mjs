import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
import fs from 'fs';
const SC=STUDY_CACHE;
const OUT=STUDY_DATA;
const t='ADA';
const s=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8'));
const f=new Map(s.funding.map(r=>[Number(r.snapshotTimestamp),r]));
const raw=fs.readFileSync(`${SC}/${t}_1750402800_1781938800.csv`,'utf8').trim().split('\n');
let shown=0;
for(const l of raw.slice(1)){
  const p=l.split(',');const ts=Math.floor(Date.parse(p[0].replace(' ','T').replace('+00:00','Z'))/1000);
  const r=f.get(ts); if(!r)continue;
  const cl=Number(p[1]); const el=Number(r.fundingFactorPerSecondLong)/1e30;
  if(cl!==el && cl!==0 && el!==0 && Math.abs((cl-el)/cl)<1e-12){
    console.log('час',new Date(ts*1000).toISOString());
    console.log('  кэш строка   :',p[1]);
    console.log('  источник цел :',r.fundingFactorPerSecondLong);
    console.log('  источник/1e30:',el);
    console.log('  кэш*1e30     :',(cl*1e30).toFixed(0), ' BigInt-разница:', BigInt(r.fundingFactorPerSecondLong)-BigInt((cl*1e30).toFixed(0)));
    if(++shown>=4)break;
  }
}
