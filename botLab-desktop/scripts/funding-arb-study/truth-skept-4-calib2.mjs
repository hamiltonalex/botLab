import fs from "node:fs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30=1e30, YR=3600*8760;
export function loadCache(tok){
  const rows=cacheRows(tok); const m=new Map();
  for(const r of rows){ const h=Math.floor(Date.parse(r.ts.replace(" ","T"))/1000/3600)*3600;
    m.set(h,{fl:+r.f_long,fs:+r.f_short}); }
  return m;
}
// раскладывает интервал на ЧАСЫ-ПЛАТЕЛЬЩИКА и ЧАСЫ-ПОЛУЧАТЕЛЯ по кэшу
export function split(cm,a,b,isLong){
  let payS=0,payD=0,recS=0,recD=0,noD=0;
  for(let h=Math.floor(a/3600)*3600;h<b;h+=3600){
    const lo=Math.max(a,h),hi=Math.min(b,h+3600),d=hi-lo; if(d<=0) continue;
    const v=cm.get(h); if(!v){noD+=d;continue;}
    const mine=Math.abs(isLong?v.fl:v.fs), other=Math.abs(isLong?v.fs:v.fl);
    if(mine<=other){ payS+=mine*d; payD+=d; } else { recS+=mine*d; recD+=d; }
  }
  return {payS,payD,recS,recD,noD};
}
export function pairs(file){
  const tr=JSON.parse(fs.readFileSync(file,"utf8"));
  const byKey=new Map();
  for(const t of tr){ if(!byKey.has(t.positionKey)) byKey.set(t.positionKey,[]); byKey.get(t.positionKey).push(t); }
  const out=[];
  for(const arr of byKey.values()){
    arr.sort((x,y)=>x.timestamp-y.timestamp||(x.id<y.id?-1:1));
    for(let i=1;i<arr.length;i++){
      const p=arr[i-1],c=arr[i];
      const dt=c.timestamp-p.timestamp; if(dt<=0) continue;
      const held=Number(p.positionSizeInUsd)/E30; if(!(held>0)) continue;
      if(p.isLong!==c.isLong) continue;
      const fund=Number(c.fundingFeeAmount)*Number(c.collateralTokenPriceMin)/E30;
      out.push({a:p.timestamp,b:c.timestamp,held,fund,isLong:c.isLong,dt});
    }
  }
  return out;
}
function calib(tok,file){
  const cm=loadCache(tok); const ps=pairs(file);
  let F=0, predPay=0, ntPay=0, ntAll=0, ntRec=0, predAll=0, nClean=0, Fclean=0, predClean=0;
  for(const x of ps){
    const s=split(cm,x.a,x.b,x.isLong);
    if(s.noD>0) continue;
    F+=x.fund;
    predPay+=x.held*s.payS; predAll+=x.held*(s.payS+s.recS);
    ntPay+=x.held*s.payD; ntRec+=x.held*s.recD; ntAll+=x.held*x.dt;
    if(s.recD===0){ nClean++; Fclean+=x.fund; predClean+=x.held*s.payS; }
  }
  return {tok,n:ps.length,F,predPay,predAll,ntPay,ntRec,ntAll,nClean,Fclean,predClean};
}
console.log("ПОЧАСОВОЕ РАЗДЕЛЕНИЕ: фандинг платится ТОЛЬКО в часы, когда наша сторона плательщик");
console.log("тк   пар    уплачено $   прогноз(часы плат.) $  прогноз(все часы) $   П/Ф(плат)  П/Ф(все)   чистых пар  чистые: Ф$ / П$   отн.");
for(const t of ["BTC","ETH","SOL"]){
  const r=calib(t,`truth-skept-raw/${t}_1761955200_1764547200.json`);
  console.log(t.padEnd(5),String(r.n).padStart(6),
    ("$"+Math.round(r.F).toLocaleString("ru-RU")).padStart(12),
    ("$"+Math.round(r.predPay).toLocaleString("ru-RU")).padStart(22),
    ("$"+Math.round(r.predAll).toLocaleString("ru-RU")).padStart(20),
    (r.predPay/r.F).toFixed(3).padStart(11),(r.predAll/r.F).toFixed(3).padStart(9),
    String(r.nClean).padStart(11),
    ("$"+Math.round(r.Fclean).toLocaleString("ru-RU")+" / $"+Math.round(r.predClean).toLocaleString("ru-RU")).padStart(20),
    (r.predClean/r.Fclean).toFixed(3).padStart(7));
}
