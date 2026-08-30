import fs from "node:fs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30=1e30, YR=8760;
const T = ["FET","S","MOODENG","BERA","FLOKI","EIGEN","WLD","STX","BONK","MEME","BOME","ORDI","TIA","LDO","WIF","AIXBT","INJ","POL"];
// на рынке m в час h: платящая сторона отдаёт payFlow $/час, принимающая сторона имеет OI recvOi.
// бот входит ноционалом N на принимающую сторону -> получает payFlow * N/(recvOi+N)
function hours(t){
  const oi=new Map(JSON.parse(fs.readFileSync(`truth-b-raw/oi_${t}.json`,"utf8"))
    .map(r=>[Math.floor(r.snapshotTimestamp/3600)*3600,{L:Number(r.longOpenInterestUsd)/E30,S:Number(r.shortOpenInterestUsd)/E30}]));
  const out=[];
  for(const r of cacheRows(t)){
    const h=Math.floor(Date.parse(r.ts.replace(" ","T"))/1000/3600)*3600;
    const o=oi.get(h); if(!o) continue;
    const fl=+r.f_long, fs2=+r.f_short;
    const recvIsLong = fl>0;
    const recvOi = recvIsLong?o.L:o.S, payOi = recvIsLong?o.S:o.L;
    const payRate = Math.abs(recvIsLong?fs2:fl);           // /сек, платящая сторона
    const recvRate = Math.abs(recvIsLong?fl:fs2);          // /сек, что видит модель
    out.push({payFlow:payRate*payOi*3600, recvOi, recvRate});
  }
  return out;
}
const NS=[100,1000,10000,100000,1000000];
console.log("Годовая доходность ноги GMX с учётом того, что бот САМ разбавляет ставку");
console.log("токен   модель(без разб.)   " + NS.map(n=>("N=$"+(n>=1000?n/1000+"k":n)).padStart(9)).join(""));
const agg = {}; NS.forEach(n=>agg[n]={inc:0});
let modelTot=0, capTot=0;
const cap=new Map(JSON.parse(fs.readFileSync("cap63.json","utf8")).map(c=>[c.t,c]));
for(const t of T){
  const H=hours(t);
  const naive = H.reduce((s,x)=>s+x.recvRate*3600,0)/H.length*YR*100;  // %год, как книжит модель
  const line=[];
  for(const N of NS){
    const inc=H.reduce((s,x)=>s+x.payFlow*N/(x.recvOi+N),0);
    const apr=inc/N/(H.length/YR)*100;
    agg[N].inc+=inc;
    line.push(apr.toFixed(1).padStart(9));
  }
  console.log(t.padEnd(7),naive.toFixed(0).padStart(15),"%  ",line.join(""));
}
console.log("\nСуммарный доход ноги GMX по 18 рынкам, $ за год, при равном ноционале N на каждом рынке:");
for(const N of NS) console.log(`  N=$${N.toLocaleString("ru-RU")} на рынок (капитал $${(N*T.length).toLocaleString("ru-RU")}):  доход $${Math.round(agg[N].inc).toLocaleString("ru-RU")}  =  ${(agg[N].inc/(N*T.length)*100).toFixed(1)}% годовых`);
