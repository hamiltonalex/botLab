import {all,SP,apr} from "./truth-v-lib.mjs"; import fs from "node:fs";
const OI=JSON.parse(fs.readFileSync(`${SP}/truth-v-oi.json`,"utf8"));
const YEAR=8761, full=[...all.keys()].filter(t=>all.get(t).length===YEAR);
// f>0 = сторона ПОЛУЧАЕТ, f<0 = сторона ПЛАТИТ (соглашение движка, math.js)
const rowsWith=new Map();
for(const t of full){ const m=new Map(OI[t].map(([ts,L,S])=>[ts,[L,S]]));
  rowsWith.set(t, all.get(t).map(r=>{ const o=m.get(r.tsHour); return o?{...r,oiL:o[0],oiS:o[1]}:null; }).filter(Boolean)); }
console.log("часов с состыкованным OI: "+[...rowsWith.values()].reduce((a,b)=>a+b.length,0)+" из "+full.length*YEAR);

// денежный поток фандинга в рынке за час = OI платящей стороны * |ставка платящей| * 3600
function flow(r){ const payLong=r.f_long<0; const oiPay=payLong?r.oiL:r.oiS; const fp=Math.abs(payLong?r.f_long:r.f_short); return oiPay*fp*3600; }
const buckets=[0.01,0.1,1,10,100,1000,Infinity];
function tab(sel,label){
  let n=0,tot=0; const b=new Array(buckets.length).fill(0);
  const flows=[];
  for(const t of full) for(const r of rowsWith.get(t)) if(sel(r,t)){ const f=flow(r); n++; tot+=f; flows.push(f);
    for(let i=0;i<buckets.length;i++) if(f<buckets[i]){b[i]++;break;} }
  flows.sort((a,b)=>a-b);
  console.log(`\n${label}: часов ${n}, суммарный поток фандинга во ВСЕХ этих рынках-часах $${tot.toFixed(0)}`);
  console.log(`  медианный поток $${flows.length?flows[Math.floor(flows.length/2)].toFixed(3):"-"}/час, p90 $${flows.length?flows[Math.floor(flows.length*0.9)].toFixed(2):"-"}/час`);
  console.log(`  распределение $/час: `+buckets.map((v,i)=>`<$${v===Infinity?"inf":v}: ${(100*b[i]/n).toFixed(1)}%`).join("  "));
}
tab(()=>true,"ВСЕ часы всех 63 рынков");
tab(r=>Math.max(Math.abs(r.f_long),Math.abs(r.f_short))>1e-7,"АНОМАЛЬНЫЕ часы (получающая ставка >1e-7 = >315% год)");
tab(r=>Math.max(Math.abs(r.f_long),Math.abs(r.f_short))>1e-6,"часы с получающей ставкой >3150% год");
tab(r=>Math.max(Math.abs(r.f_long),Math.abs(r.f_short))<=1e-7,"НЕаномальные часы");

// сколько всего денег фандинга существовало во всех 63 рынках за год
let tot=0, byT=[];
for(const t of full){ let s=0; for(const r of rowsWith.get(t)) s+=flow(r); byT.push({t,s}); tot+=s; }
console.log(`\n=== ВЕСЬ ГОДОВОЙ ПОТОК ФАНДИНГА ВО ВСЕХ 63 РЫНКАХ GMX: $${tot.toFixed(0)} ===`);
console.log("это верхняя граница ВСЕГО, что могли получить ВСЕ получающие стороны вместе взятые.");
byT.sort((a,b)=>b.s-a.s);
console.log("\nтоп-15 рынков по годовому потоку фандинга:");
for(const r of byT.slice(0,15)) console.log(`  ${r.t.padEnd(10)} $${r.s.toFixed(0)}`);
console.log("\nхвост, 15 самых бедных:");
for(const r of byT.slice(-15)) console.log(`  ${r.t.padEnd(10)} $${r.s.toFixed(2)}`);
// 28 чистых
const CL="AAVE ADA ARB AVAX BNB BTC DOGE DOT ENA ETH FARTCOIN GMX HYPE LINK LTC PENDLE PENGU PEPE SEI SOL SUI S TAO TRX UNI VIRTUAL XLM XRP".split(" ");
const clTot=byT.filter(r=>CL.includes(r.t)).reduce((a,b)=>a+b.s,0);
console.log(`\nгодовой поток фандинга в 28 ЧИСТЫХ рынках: $${clTot.toFixed(0)}`);
