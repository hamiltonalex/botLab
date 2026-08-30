import fs from "node:fs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30=1e30, YR=3600*8760;
function loadCache(tok){
  const rows=cacheRows(tok); const m=new Map();
  for(const r of rows){ const h=Math.floor(Date.parse(r.ts.replace(" ","T"))/1000/3600)*3600;
    m.set(h,{fl:+r.f_long, fs:+r.f_short}); }
  return m;
}
// интеграл |ставки| нужной стороны по часам интервала, с весом длительности внутри часа
function cacheInt(cm,a,b,isLong){
  let s=0,w=0;
  for(let h=Math.floor(a/3600)*3600; h<b; h+=3600){
    const v=cm.get(h); if(!v) continue;
    const lo=Math.max(a,h), hi=Math.min(b,h+3600); const d=hi-lo; if(d<=0) continue;
    s+=Math.abs(isLong?v.fl:v.fs)*d; w+=d;
  }
  return w>0?{avg:s/w, cov:w/(b-a)}:null;
}
// доля времени, когда наша сторона по кэшу была ПЛАТЕЛЬЩИКОМ (|наша| == min)
function payerFrac(cm,a,b,isLong){
  let p=0,n=0;
  for(let h=Math.floor(a/3600)*3600; h<b; h+=3600){
    const v=cm.get(h); if(!v) continue; n++;
    const mine=Math.abs(isLong?v.fl:v.fs), other=Math.abs(isLong?v.fs:v.fl);
    if(mine<=other) p++;
  }
  return n?p/n:null;
}
function run(tok,file,A,B){
  const tr=JSON.parse(fs.readFileSync(file,"utf8"));
  const cm=loadCache(tok);
  const byKey=new Map();
  for(const t of tr){ if(!byKey.has(t.positionKey)) byKey.set(t.positionKey,[]); byKey.get(t.positionKey).push(t); }
  let sF=0,sNT=0,sC=0,sNT2=0,nIv=0,nPos=0,nZeroFund=0;
  let payW=0, payWn=0;
  const recvIv=[];
  for(const arr of byKey.values()){
    arr.sort((x,y)=>x.timestamp-y.timestamp||(x.id<y.id?-1:1));
    for(let i=1;i<arr.length;i++){
      const p=arr[i-1],c=arr[i];
      const dt=c.timestamp-p.timestamp; if(dt<=0) continue;
      const held=Number(p.positionSizeInUsd)/E30; if(!(held>0)) continue;
      if(p.isLong!==c.isLong) continue;
      const fund=Number(c.fundingFeeAmount)*Number(c.collateralTokenPriceMin)/E30;
      nIv++;
      const nt=held*dt;
      const pf=payerFrac(cm,p.timestamp,c.timestamp,c.isLong);
      if(pf!=null){ payW+=pf*nt; payWn+=nt; }
      if(!(fund>0)){ nZeroFund++; if(pf!=null&&pf>0.9) recvIv.push({nt,pf}); continue; }
      nPos++;
      const ca=cacheInt(cm,p.timestamp,c.timestamp,c.isLong);
      sF+=fund; sNT+=nt;
      if(ca){ sC+=ca.avg*nt; sNT2+=nt; }
    }
  }
  const factR=sF/sNT, cacheR=sC/sNT2;
  return {tok,nIv,nPos,nZeroFund,ntH:sNT/3600,factR,cacheR,
    ratio:cacheR/factR, payFrac:payW/payWn, sF,
    zeroButPayer: recvIv.length, zeroButPayerNT: recvIv.reduce((s,x)=>s+x.nt,0)/3600};
}
const A=1761955200,B=1764547200;
console.log("КАЛИБРОВКА МЕТОДА Б НА ЗАВЕДОМО НОРМАЛЬНЫХ РЫНКАХ (2025-11-01..2025-12-01)");
console.log("тк   интерв  с фанд  нулевых  ноц-часов   ФАКТ %год   КЭШ %год   КЭШ/ФАКТ  доля(наша=плательщик)  уплачено $  нулевых-но-плательщик(ноц-ч)");
for(const t of ["BTC","ETH","SOL"]){
  const r=run(t,`truth-skept-raw/${t}_${A}_${B}.json`,A,B);
  console.log(t.padEnd(5),String(r.nIv).padStart(6),String(r.nPos).padStart(7),String(r.nZeroFund).padStart(8),
    r.ntH.toExponential(3).padStart(11), (r.factR*YR*100).toFixed(2).padStart(11),
    (r.cacheR*YR*100).toFixed(2).padStart(10), r.ratio.toFixed(3).padStart(10),
    (r.payFrac*100).toFixed(1).padStart(20)+"%", ("$"+Math.round(r.sF).toLocaleString("ru-RU")).padStart(12),
    r.zeroButPayerNT.toExponential(2).padStart(12));
}
