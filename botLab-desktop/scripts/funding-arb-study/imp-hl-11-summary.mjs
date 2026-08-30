import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP=STUDY_DATA;
const J=JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`,"utf8"));
const XS=J.meta.xs, T=J.tokens, names=Object.keys(T);
const qs=(a,p)=>{const s=a.filter(Number.isFinite).sort((x,y)=>x-y);return s.length?s[Math.min(s.length-1,Math.floor(p*(s.length-1)))]:NaN;};
const RT=(d,k,i)=>{const b=d[k].buy.bps[i],s=d[k].sell.bps[i];return (b==null||s==null)?null:b+s;};

for(const k of ["raw","correctedSqrt","correctedLinear"]){
  console.log(`=== ${k}: КРУГ ПО НОГЕ HL (вход+выход), бп от ноционала, по 63 именам ===`);
  console.log("     X      живых  медиана   25%    75%    90%   ср.по_живым");
  for(let i=0;i<XS.length;i++){
    const v=names.map(t=>RT(T[t],k,i));
    const live=v.filter(Number.isFinite);
    console.log(("$"+(XS[i]/1000)+"k").padStart(7),String(live.length+"/63").padStart(8),
      qs(live,.5).toFixed(1).padStart(8),qs(live,.25).toFixed(1).padStart(7),
      qs(live,.75).toFixed(1).padStart(7),qs(live,.9).toFixed(1).padStart(7),
      (live.reduce((a,b)=>a+b,0)/live.length).toFixed(1).padStart(12));
  }
  console.log();
}
console.log("=== СКОЛЬКО ИМЁН ДЕРЖИТ КРУГ ПО HL ДЕШЕВЛЕ ПОРОГА (сырой стакан) ===");
console.log("     X    <10бп  <25бп  <50бп  <100бп");
for(let i=0;i<XS.length;i++){
  const v=names.map(t=>RT(T[t],"raw",i)).filter(Number.isFinite);
  console.log(("$"+(XS[i]/1000)+"k").padStart(7),
    ...[10,25,50,100].map(th=>String(v.filter(x=>x<th).length).padStart(6)));
}
console.log();
console.log("=== ТО ЖЕ, ПОПРАВКА ПО ОБОРОТУ (корневая) ===");
console.log("     X    <10бп  <25бп  <50бп  <100бп");
for(let i=0;i<XS.length;i++){
  const v=names.map(t=>RT(T[t],"correctedSqrt",i)).filter(Number.isFinite);
  console.log(("$"+(XS[i]/1000)+"k").padStart(7),
    ...[10,25,50,100].map(th=>String(v.filter(x=>x<th).length).padStart(6)));
}
console.log();
console.log("=== ЧТО СВЯЗЫВАЕТ РАНЬШЕ: нога HL (25 бп круга) или свободная ликвидность GMX ===");
console.log("token       X_HL@25бп_круга$   GMX_availShort$   GMX_availLong$   связывает");
const rows=names.map(t=>{
  const d=T[t];
  const hl=Math.min(d.raw.buy.ntlAtBps[25]??0, d.raw.sell.ntlAtBps[25]??0);
  const g=Math.min(d.gmxAvail.availShort,d.gmxAvail.availLong);
  return {t,hl,gS:d.gmxAvail.availShort,gL:d.gmxAvail.availLong,g,bind:hl<g?"HL":"GMX"};
}).sort((a,b)=>Math.min(b.hl,b.g)-Math.min(a.hl,a.g));
for(const r of rows) console.log(r.t.padEnd(11),Math.round(r.hl).toLocaleString("en").padStart(17),
  Math.round(r.gS).toLocaleString("en").padStart(17),Math.round(r.gL).toLocaleString("en").padStart(16),r.bind.padStart(11));
console.log();
console.log("связывает GMX у",rows.filter(r=>r.bind==="GMX").length,"имён, нога HL у",rows.filter(r=>r.bind==="HL").length);
console.log("сумма min(HL@25бп, GMX) по 63 именам: $"+Math.round(rows.reduce((a,r)=>a+Math.min(r.hl,r.g),0)).toLocaleString("en"));
