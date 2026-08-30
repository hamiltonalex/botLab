import fs from "node:fs";
import { TOKS, marketHours } from "./truth-skept-9-core.mjs";
const F=JSON.parse(fs.readFileSync("truth-skept-flow.json","utf8"));
const N=10000; const rows=[];
for(const t of TOKS){
  const M=marketHours(t); if(!M) continue;
  let naive=0, dil=0, flipLoss=0, keep=0;
  for(const r of M){
    const al=Math.abs(r.fl),as=Math.abs(r.fs);
    if(!(al>0&&as>0&&r.bl>0&&r.bs>0)) continue;
    const pL=r.bl>r.bs, pr=pL?al:as, pb=pL?r.bl:r.bs, rr=pL?as:al, rb=pL?r.bs:r.bl;
    naive+=rr*3600*N; const sh=N/(rb+N), fh=pr*pb*3600;
    dil+=fh*sh;
    if(rb+N>pb) flipLoss+=pr*3600*N; else keep+=fh*sh;
  }
  rows.push({t,mkt:F.flow[t],claimed:F.claimed[t]||0,naive,dil,keep,net:keep-flipLoss});
}
const over=rows.filter(r=>r.naive>r.mkt).sort((a,b)=>b.naive/b.mkt-a.naive/a.mkt);
console.log("рынков, где модель книжит себе БОЛЬШЕ, чем весь рынок заплатил за год:", over.length, "из", rows.length);
console.log("\nтк      весь рынок $  заявлено получ. $   модель себе $   x рынок   разбавл. $  с учётом смены знака $");
for(const r of over.slice(0,12)) console.log(r.t.padEnd(9),("$"+Math.round(r.mkt).toLocaleString("ru-RU")).padStart(12),
  ("$"+Math.round(r.claimed).toLocaleString("ru-RU")).padStart(17),("$"+Math.round(r.naive).toLocaleString("ru-RU")).padStart(15),
  (r.naive/r.mkt).toFixed(1).padStart(9),("$"+Math.round(r.dil).toLocaleString("ru-RU")).padStart(12),
  ("$"+Math.round(r.net).toLocaleString("ru-RU")).padStart(22));
const sN=rows.reduce((s,r)=>s+r.naive,0), sD=rows.reduce((s,r)=>s+r.dil,0), sNet=rows.reduce((s,r)=>s+r.net,0), sM=rows.reduce((s,r)=>s+r.mkt,0);
console.log("\nвсего: рынок $"+Math.round(sM).toLocaleString("ru-RU")+"  модель $"+Math.round(sN).toLocaleString("ru-RU")+
  "  разбавл. $"+Math.round(sD).toLocaleString("ru-RU")+"  со сменой знака $"+Math.round(sNet).toLocaleString("ru-RU"));
console.log("рынков с ОТРИЦАТЕЛЬНЫМ итогом после учёта смены знака:", rows.filter(r=>r.net<0).length, "из", rows.length);
