import fs from "node:fs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30=1e30,YR=3600*8760;
const T=["FET","MOODENG","BOME","ORDI","BERA","WIF","MEME","STX"];
function q(a,p){const s=[...a].sort((x,y)=>x-y);return s[Math.floor(p*(s.length-1))];}
console.log("Ставка ПЛАТЯЩЕЙ стороны (та, что ограничена протоколом) против ставки ПОЛУЧАЮЩЕЙ");
console.log("токен    платящая: медиана   p99      макс      | получающая: макс        отношение макс");
for(const t of T){
  const oi=new Map(JSON.parse(fs.readFileSync(`truth-b-raw/oi_${t}.json`,"utf8"))
    .map(r=>[Math.floor(r.snapshotTimestamp/3600)*3600,{L:Number(r.longOpenInterestUsd)/E30,S:Number(r.shortOpenInterestUsd)/E30}]));
  const pay=[],rec=[];
  for(const r of cacheRows(t)){
    const h=Math.floor(Date.parse(r.ts.replace(" ","T"))/1000/3600)*3600;
    const o=oi.get(h); if(!o) continue;
    const fl=+r.f_long,fs2=+r.f_short,rl=fl>0;
    pay.push(Math.abs(rl?fs2:fl)); rec.push(Math.abs(rl?fl:fs2));
  }
  console.log(t.padEnd(8),(q(pay,.5)*YR*100).toFixed(1).padStart(13)+"%",(q(pay,.99)*YR*100).toFixed(0).padStart(7)+"%",
    (Math.max(...pay)*YR*100).toExponential(2).padStart(10),"  |",(Math.max(...rec)*YR*100).toExponential(2).padStart(12),
    (Math.max(...rec)/Math.max(...pay)).toFixed(0).padStart(14)+"x");
}
