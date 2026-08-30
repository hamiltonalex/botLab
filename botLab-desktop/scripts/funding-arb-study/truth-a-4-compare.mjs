import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
// Побитовая сверка кэша с первоисточником: все часы, отдельно аномальные, границы, дыры.
import fs from 'fs';
const SC=STUDY_CACHE;
const OUT=STUDY_DATA;
const A=JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8'));
const names=Object.keys(A.perTok);
const START=1750402800,END=1781938800;
const bits=x=>{const b=new DataView(new ArrayBuffer(8));b.setFloat64(0,x);return b.getBigUint64(0);};
const S=1e30;
let tot={hours:0,cmpF:0,eqF:0,cmpB:0,eqB:0,anom:0,anomEq:0,offHour:0,dupHour:0,
  cacheNoSrc:0,srcNoCacheInWin:0,firstEq:0,lastEq:0,pageEq:0,pageCmp:0,neZeroSign:0};
const bad=[]; const perTok={};
for(const t of names){
  const src=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8'));
  // источник -> почасовая карта, ровно как _to_hourly: сортировка, дедуп по сырой метке (keep last), floor часа, дедуп (keep last)
  const f=new Map(), b=new Map();
  const pageIdx=new Set();
  src.funding.forEach((r,i)=>{
    const ts=Number(r.snapshotTimestamp);
    if(ts%3600!==0) tot.offHour++;
    const h=Math.floor(ts/3600)*3600;
    if(f.has(h)) tot.dupHour++;
    f.set(h,r);
    if(i>0 && i%1000===0) pageIdx.add(h);   // первый элемент новой страницы пагинации
    if(i>0 && i%1000===999) pageIdx.add(h); // последний элемент страницы
  });
  src.borrowing.forEach(r=>{const h=Math.floor(Number(r.snapshotTimestamp)/3600)*3600;b.set(h,r);});
  const raw=fs.readFileSync(`${SC}/${t}_1750402800_1781938800.csv`,'utf8').trim().split('\n');
  const rows=raw.slice(1).map(l=>{const p=l.split(',');return {ts:Math.floor(Date.parse(p[0].replace(' ','T').replace('+00:00','Z'))/1000),
     f_long:p[1],f_short:p[2],b_long:p[3],b_short:p[4]};});
  const cacheTs=new Set(rows.map(r=>r.ts));
  const p={hours:rows.length,mismF:0,mismB:0,anom:0,anomEq:0,noSrc:0};
  rows.forEach((r,idx)=>{
    tot.hours++;
    const sf=f.get(r.ts), sb=b.get(r.ts);
    if(!sf){p.noSrc++;tot.cacheNoSrc++;bad.push({t,ts:r.ts,why:'нет снимка funding в источнике'});return;}
    const cl=Number(r.f_long), cs=Number(r.f_short);
    const el=Number(sf.fundingFactorPerSecondLong)/S, es=Number(sf.fundingFactorPerSecondShort)/S;
    tot.cmpF+=2;
    const okl=bits(cl)===bits(el), oks=bits(cs)===bits(es);
    if(okl)tot.eqF++;else if(cl===el){tot.eqF++;tot.neZeroSign++;}
    if(oks)tot.eqF++;else if(cs===es){tot.eqF++;tot.neZeroSign++;}
    if(cl!==el||cs!==es){p.mismF++;bad.push({t,ts:r.ts,why:'funding не совпал',cache:[r.f_long,r.f_short],src:[el,es]});}
    const isAnom=Math.max(Math.abs(cl),Math.abs(cs))>1e-7;
    if(isAnom){tot.anom++;p.anom++;if(cl===el&&cs===es){tot.anomEq++;p.anomEq++;}}
    if(sb){
      const bl=Number(r.b_long),bs=Number(r.b_short);
      const ebl=Number(sb.borrowingFactorPerSecondLong)/S, ebs=Number(sb.borrowingFactorPerSecondShort)/S;
      tot.cmpB+=2; if(bl===ebl)tot.eqB++; if(bs===ebs)tot.eqB++;
      if(bl!==ebl||bs!==ebs){p.mismB++;bad.push({t,ts:r.ts,why:'borrow не совпал',cache:[r.b_long,r.b_short],src:[ebl,ebs]});}
    }
    if(idx===0 && cl===el && cs===es) tot.firstEq++;
    if(idx===rows.length-1 && cl===el && cs===es) tot.lastEq++;
    if(pageIdx.has(r.ts)){tot.pageCmp++; if(cl===el&&cs===es)tot.pageEq++;}
  });
  for(const h of f.keys()) if(h>=START&&h<=END&&!cacheTs.has(h)){tot.srcNoCacheInWin++;}
  perTok[t]=p;
}
console.log(JSON.stringify(tot,null,1));
console.log('имена с расхождениями:',Object.entries(perTok).filter(([,p])=>p.mismF||p.mismB||p.noSrc).map(([k,p])=>k+':'+JSON.stringify(p)).join(' | ')||'нет');
console.log('примеры плохих:',JSON.stringify(bad.slice(0,10)));
fs.writeFileSync(OUT+'/truth-a-compare.json',JSON.stringify({tot,perTok,badCount:bad.length,bad:bad.slice(0,500)}));
