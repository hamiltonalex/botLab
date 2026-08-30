import fs from "node:fs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30=1e30, YR=8760, N=10000;
const T=JSON.parse(fs.readFileSync("cap63.json","utf8")).map(c=>c.t).filter(t=>fs.existsSync(`truth-b-raw/oi_${t}.json`));
let over=0; const rows=[];
for(const t of T){
  const oi=new Map(JSON.parse(fs.readFileSync(`truth-b-raw/oi_${t}.json`,"utf8"))
    .map(r=>[Math.floor(r.snapshotTimestamp/3600)*3600,{L:Number(r.longOpenInterestUsd)/E30,S:Number(r.shortOpenInterestUsd)/E30}]));
  let mk=0,nv=0,di=0;
  for(const r of cacheRows(t)){
    const h=Math.floor(Date.parse(r.ts.replace(" ","T"))/1000/3600)*3600;
    const o=oi.get(h); if(!o) continue;
    const fl=+r.f_long,fs2=+r.f_short,rl=fl>0;
    const ro=rl?o.L:o.S,po=rl?o.S:o.L;
    const pf=Math.abs(rl?fs2:fl)*po*3600;
    mk+=pf; nv+=Math.abs(rl?fl:fs2)*3600*N; di+=pf*N/(ro+N);
  }
  rows.push({t,mk,nv,di,ratio:nv/mk,overs:nv/di});
  if(nv>mk) over++;
}
rows.sort((a,b)=>b.ratio-a.ratio);
console.log(`Рынков, где модель на ноционале $${N.toLocaleString("ru-RU")} книжит СЕБЕ больше, чем весь рынок выплатил ВСЕМ: ${over} из ${T.length}\n`);
console.log("токен    весь рынок за год $   модель себе $   модель/рынок   реально снимаемо $   завышение");
for(const r of rows.slice(0,18))
  console.log(r.t.padEnd(9),("$"+Math.round(r.mk).toLocaleString("ru-RU")).padStart(15),("$"+Math.round(r.nv).toLocaleString("ru-RU")).padStart(15),
    r.ratio.toFixed(1).padStart(13)+"x",("$"+Math.round(r.di).toLocaleString("ru-RU")).padStart(18),r.overs.toFixed(0).padStart(10)+"x");
const tot=rows.reduce((s,r)=>s+r.nv,0), totd=rows.reduce((s,r)=>s+r.di,0);
console.log(`\nПо всем 63: модель ${(tot/totd).toFixed(1)}x завышает против физически снимаемого.`);
console.log(`Медиана завышения по рынку: ${rows.map(r=>r.overs).sort((a,b)=>a-b)[Math.floor(rows.length/2)].toFixed(1)}x`);
