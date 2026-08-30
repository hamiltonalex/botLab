import { DATA as STUDY_DATA } from "./paths.mjs";
// Насколько исторические ставки выше сегодняшнего потолка протокола.
import fs from 'fs';
const OUT=STUDY_DATA;
const info=JSON.parse(fs.readFileSync(OUT+'/truth-a-marketinfo.json','utf8'));
const S=1e30, APR=x=>x*3600*8760*100;
let n=0,over=0; const pays=[]; let byMonth={};
for(const t of Object.keys(info)){
  const F=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8')).funding;
  const cap=Number(info[t].maxFundingFactorPerSecondLong)/S;
  for(const r of F){const fl=Number(r.fundingFactorPerSecondLong)/S,fs_=Number(r.fundingFactorPerSecondShort)/S;
    if(!fl||!fs_||Math.sign(fl)===Math.sign(fs_))continue;
    const pv=Math.abs(fl<0?fl:fs_); n++; pays.push(pv);
    const m=new Date(Number(r.snapshotTimestamp)*1000).toISOString().slice(0,7);
    byMonth[m]=byMonth[m]||[0,0]; byMonth[m][1]++; if(pv>cap*1.000001){over++;byMonth[m][0]++;}}
}
pays.sort((a,b)=>a-b);
const q=p=>APR(pays[Math.floor(p*(pays.length-1))]).toFixed(1)+'%';
console.log('ставка стороны-плательщика за год, годовых: медиана',q(0.5),'p90',q(0.9),'p99',q(0.99),'макс',q(1));
console.log('часов выше СЕГОДНЯШНЕГО потолка рынка:',over,'из',n,(100*over/n).toFixed(1)+'%');
console.log('по месяцам, доля часов выше сегодняшнего потолка:');
for(const m of Object.keys(byMonth).sort())console.log('  ',m,(100*byMonth[m][0]/byMonth[m][1]).toFixed(1)+'%');
