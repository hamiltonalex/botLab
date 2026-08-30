import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP=STUDY_DATA;
const {DEFAULT_COSTS,roundTripCost}=await import("../../src/engine/costs.js");
const J=JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`,"utf8"));
const XS=J.meta.xs, T=J.tokens;

console.log("=== ПОДТВЕРЖДЕНИЕ ПЛОСКОСТИ ТЕКУЩЕЙ МОДЕЛИ (движковый roundTripCost) ===");
console.log("     X     круг$        круг_бп   в т.ч. нога HL, бп (hlTaker*hlSides)");
for(const x of XS) console.log(("$"+(x/1000)+"k").padStart(7),
  ("$"+roundTripCost(DEFAULT_COSTS,x,false).toFixed(0)).padStart(10),
  (roundTripCost(DEFAULT_COSTS,x,false)/x*1e4).toFixed(1).padStart(11),
  (DEFAULT_COSTS.hlTaker*DEFAULT_COSTS.hlSides*100).toFixed(1).padStart(12));
console.log("-> у ноги HL в модели ровно 9.0 бп на любом размере, проскальзывания нет вовсе");
console.log();

// степенная подгонка круга по ноге HL: bps = a*(X/10000)^b, по живым точкам
const qs=(a,p)=>{const s=a.filter(Number.isFinite).sort((x,y)=>x-y);return s[Math.floor(p*(s.length-1))];};
for(const [t,d] of Object.entries(T)){
  for(const k of ["raw","correctedSqrt","correctedLinear"]){
    const pts=[];
    for(let i=0;i<XS.length;i++){
      const b=d[k].buy.bps[i], s=d[k].sell.bps[i];
      if(b!=null&&s!=null&&b+s>0) pts.push([Math.log(XS[i]/1e4),Math.log(b+s)]);
    }
    if(pts.length<3){ d[k].fit=null; continue; }
    const n=pts.length, sx=pts.reduce((a,p)=>a+p[0],0), sy=pts.reduce((a,p)=>a+p[1],0);
    const sxx=pts.reduce((a,p)=>a+p[0]*p[0],0), sxy=pts.reduce((a,p)=>a+p[0]*p[1],0);
    const b1=(n*sxy-sx*sy)/(n*sxx-sx*sx), b0=(sy-b1*sx)/n;
    const pred=(X)=>Math.exp(b0)*Math.pow(X/1e4,b1);
    const err=pts.map(p=>Math.abs(pred(1e4*Math.exp(p[0]))-Math.exp(p[1]))/Math.exp(p[1]));
    d[k].fit={form:"bpsRoundTrip = a*(X/10000)^b", a:+Math.exp(b0).toFixed(3), b:+b1.toFixed(3),
      nPts:n, medRelErr:+qs(err,.5).toFixed(3)};
  }
}
J.meta.fitNote="fit: круг по ноге HL (вход+выход, покупка+продажа) в бп от ноционала; степенная регрессия по живым точкам кривой";
fs.writeFileSync(`${SP}/impact-hl.json`,JSON.stringify(J,null,1));

const A=Object.entries(T).map(([t,d])=>({t,...d.raw.fit})).filter(x=>x.a);
console.log("=== СТЕПЕННАЯ ФОРМА КРУГА ПО HL: bps = a*(X/$10k)^b (сырой стакан) ===");
console.log("подогнано у",A.length,"имён; медиана a =",qs(A.map(x=>x.a),.5).toFixed(1),
  "бп, медиана b =",qs(A.map(x=>x.b),.5).toFixed(2),
  ", медиана относит. ошибки",(100*qs(A.map(x=>x.medRelErr),.5)).toFixed(0)+"%");
console.log("квартили b:",qs(A.map(x=>x.b),.25).toFixed(2),"/",qs(A.map(x=>x.b),.5).toFixed(2),"/",qs(A.map(x=>x.b),.75).toFixed(2),
  " -> ближе к квадратному корню (0.5), а не к плоскому (0)");
console.log();
console.log("token       a(бп@$10k)   b     мед.ошибка");
for(const x of A.sort((p,q)=>p.a-q.a)) console.log(x.t.padEnd(11),x.a.toFixed(2).padStart(10),x.b.toFixed(3).padStart(7),(100*x.medRelErr).toFixed(0).padStart(11)+"%");
