import fs from "node:fs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30=1e30, YR=8760;
const T=JSON.parse(fs.readFileSync("cap63.json","utf8")).map(c=>c.t).filter(t=>fs.existsSync(`truth-b-raw/oi_${t}.json`));
function hours(t){
  const oi=new Map(JSON.parse(fs.readFileSync(`truth-b-raw/oi_${t}.json`,"utf8"))
    .map(r=>[Math.floor(r.snapshotTimestamp/3600)*3600,{L:Number(r.longOpenInterestUsd)/E30,S:Number(r.shortOpenInterestUsd)/E30}]));
  const out=[];
  for(const r of cacheRows(t)){
    const h=Math.floor(Date.parse(r.ts.replace(" ","T"))/1000/3600)*3600;
    const o=oi.get(h); if(!o) continue;
    const fl=+r.f_long, fs2=+r.f_short, recvIsLong=fl>0;
    const recvOi=recvIsLong?o.L:o.S, payOi=recvIsLong?o.S:o.L;
    const payR=Math.abs(recvIsLong?fs2:fl), recvR=Math.abs(recvIsLong?fl:fs2);
    const bor=recvIsLong?+r.b_long:+r.b_short;   // издержка займа на стороне бота
    out.push({payFlow:payR*payOi*3600, recvOi, recvR, bor});
  }
  return out;
}
let market=0, naiveInc=0;
const NS=[1000,10000,50000,100000];
const agg={}, aggNet={}; NS.forEach(n=>{agg[n]=0;aggNet[n]=0;});
const N_MODEL=10000;
for(const t of T){
  const H=hours(t);
  market += H.reduce((s,x)=>s+x.payFlow,0);
  naiveInc += H.reduce((s,x)=>s+x.recvR*3600*N_MODEL,0);       // как книжит модель на $10k
  for(const N of NS){
    const g=H.reduce((s,x)=>s+x.payFlow*N/(x.recvOi+N),0);
    const b=H.reduce((s,x)=>s+x.bor*3600*N,0);
    agg[N]+=g; aggNet[N]+=g-b;
  }
}
console.log(`Все ${T.length} рынков с полным годом, окно 2025-06-20..2026-06-20\n`);
console.log("1) ВЕСЬ фандинг, реально уплаченный на этих рынках ВСЕМИ участниками за год:");
console.log(`   $${Math.round(market).toLocaleString("ru-RU")}\n`);
console.log(`2) Что насчитала бы модель бота 1 (ставка кэша x ноционал, без разбавления), $${N_MODEL.toLocaleString("ru-RU")} на рынок:`);
console.log(`   $${Math.round(naiveInc).toLocaleString("ru-RU")}  =  ${(naiveInc/market).toFixed(1)}x всего рынка`);
console.log(`   капитал $${(N_MODEL*T.length).toLocaleString("ru-RU")}  ->  ${(naiveInc/(N_MODEL*T.length)*100).toFixed(0)}% годовых\n`);
console.log("3) Что физически можно снять, с учётом собственного разбавления ставки:");
console.log("   ноционал/рынок    капитал      валовой доход   % год(вал)   за вычетом займа   % год(нетто)");
for(const N of NS){
  const K=N*T.length;
  console.log(`   $${N.toLocaleString("ru-RU").padStart(9)}  $${K.toLocaleString("ru-RU").padStart(10)}   $${Math.round(agg[N]).toLocaleString("ru-RU").padStart(11)}  ${(agg[N]/K*100).toFixed(1).padStart(9)}%   $${Math.round(aggNet[N]).toLocaleString("ru-RU").padStart(11)}   ${(aggNet[N]/K*100).toFixed(1).padStart(9)}%`);
}
console.log("\n   (это ВАЛОВАЯ нога GMX: без ноги HL, комиссий, проскальзывания и конкуренции других шортов)");
