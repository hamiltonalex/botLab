import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
// Скан кэша: аномальные часы (фактор выше 1e-7/с) и замороженные серии.
import fs from 'fs';
const SC=STUDY_CACHE;
const OUT=STUDY_DATA;
const cap=JSON.parse(fs.readFileSync(OUT+'/cap63.json','utf8'));
const names=cap.map(x=>x.t);
// mapping token -> gmx_market
const sr=fs.readFileSync(SC+'/_scan_results.csv','utf8').trim().split('\n');
const hdr=sr[0].split(',');
const iTok=hdr.indexOf('token'), iMkt=hdr.indexOf('gmx_market'), iCoin=hdr.indexOf('hl_coin');
const mkt={};
for(const line of sr.slice(1)){const p=line.split(',');mkt[p[iTok]]={market:p[iMkt],coin:p[iCoin]};}
const load=t=>{
  const raw=fs.readFileSync(`${SC}/${t}_1750402800_1781938800.csv`,'utf8').trim().split('\n');
  const h=raw[0].split(',');
  const rows=raw.slice(1).map(l=>{const p=l.split(',');const o={};h.forEach((k,i)=>o[k]=p[i]);
    o.ts=Math.floor(Date.parse(o.ts.replace(' ','T').replace('+00:00','Z'))/1000);return o;});
  return rows;
};
const CEIL=1e-7;
let defs={maxAbsF:0,absLong:0,absShort:0,maxF:0};
const perTok={};
const anomalies=[]; // {t, ts, f_long, f_short}
for(const t of names){
  const rows=load(t);
  let n=0;
  for(const r of rows){
    const fl=Number(r.f_long), fs_=Number(r.f_short);
    const m=Math.max(Math.abs(fl),Math.abs(fs_));
    if(m>CEIL){defs.maxAbsF++;n++;anomalies.push({t,ts:r.ts,f_long:r.f_long,f_short:r.f_short,b_long:r.b_long,b_short:r.b_short});}
    if(Math.abs(fl)>CEIL)defs.absLong++;
    if(Math.abs(fs_)>CEIL)defs.absShort++;
    if(Math.max(fl,fs_)>CEIL)defs.maxF++;
  }
  perTok[t]={hours:rows.length,anom:n};
}
console.log('определения аномалии:',JSON.stringify(defs));
console.log('всего часов:',Object.values(perTok).reduce((a,b)=>a+b.hours,0));
console.log('имён с аномалиями (maxAbsF):',Object.values(perTok).filter(x=>x.anom>0).length);
fs.writeFileSync(OUT+'/truth-a-anomalies.json',JSON.stringify({perTok,anomalies,mkt},null,0));
console.log('аномальных часов записано:',anomalies.length);
