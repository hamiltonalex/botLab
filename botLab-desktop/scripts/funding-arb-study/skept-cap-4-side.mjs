import { CACHE as STUDY_CACHE } from "./paths.mjs";
import fs from "node:fs";
import { all, full, YEAR, H1, scanTwoLeg, capRows, SP, walk, pc } from "./skept-cap-lib.mjs";
const E=1e30, num=(x)=>Number(x)/E;
// мэппинг и сырые рынки
const lines = fs.readFileSync(STUDY_CACHE+"/_scan_results.csv","utf8").trim().split("\n");
const head=lines[0].split(","), ix=Object.fromEntries(head.map((h,i)=>[h,i]));
const map=new Map();
for(const l of lines.slice(1)){const p=l.split(",");map.set(p[ix.token],{config:p[ix.config],gmxLeg:p[ix.gmx_leg],gmxMarket:(p[ix.gmx_market]||"").toLowerCase()});}
const gmx=new Map();
for(const f of ["mi.json","mi-avax.json"]){const d=JSON.parse(fs.readFileSync(`${SP}/${f}`,"utf8"));for(const m of (d.markets??d))gmx.set(m.marketToken.toLowerCase(),{availLong:num(m.availableLiquidityLong),availShort:num(m.availableLiquidityShort),oiL:num(m.openInterestLong),oiS:num(m.openInterestShort)});}

// какой конфиг движок реально выбирает в каждом обучающем окне W=90
const W=90,H=30,trainH=W*H1,holdH=H*H1;
const per_=[];for(let i=trainH;i+24<=YEAR;i+=holdH){const te=Math.min(YEAR,i+holdH);if(te-i<24)break;per_.push([i,te]);}
console.log("# СТОРОНА GMX: статическая метка из _scan_results (её берёт фильтр) против того, что выбирает движок");
console.log("| токен | статич. нога (для avail) | конфиги по 10 окнам | availShort $ | availLong $ | берётся $ | «правильная» по факту $ |");
let flipped=0;
for (const t of full) {
  const m=map.get(t); const g=gmx.get(m.gmxMarket);
  const cfgs=per_.map(([i])=>{const sc=scanTwoLeg(all.get(t).slice(i-trainH,i),{token:t});return sc?sc.chosen:"-";});
  const distinct=[...new Set(cfgs)].join("");
  const staticSide=m.gmxLeg;               // 'short' => A, 'long' => B
  const taken = staticSide==="short"? g.availShort : g.availLong;
  // «по факту»: минимум ликвидности по тем сторонам, которые движок реально выбирал
  const sides=new Set(cfgs.filter(c=>c!=="-").map(c=>c==="A"?"short":"long"));
  const real = Math.min(...[...sides].map(s=>s==="short"?g.availShort:g.availLong));
  const mism = cfgs.some(c=> (c==="A"?"short":"long") !== staticSide);
  if (mism) flipped++;
  console.log(`| ${t} | ${staticSide} | ${cfgs.join("")} (${distinct}) | ${g.availShort.toFixed(0)} | ${g.availLong.toFixed(0)} | ${taken.toFixed(0)} | ${real.toFixed(0)} | ${mism?"РАСХОЖДЕНИЕ":""}`);
}
console.log(`\nимён, где движок хоть раз брал ДРУГУЮ сторону GMX, чем берёт фильтр: ${flipped} из ${full.length}`);

// перезапуск фильтра с «правильной» стороной (минимум по реально выбираемым сторонам)
const realAvail=new Map();
for(const t of full){const m=map.get(t),g=gmx.get(m.gmxMarket);
 const sides=new Set(per_.map(([i])=>{const sc=scanTwoLeg(all.get(t).slice(i-trainH,i),{token:t});return sc?(sc.chosen==="A"?"short":"long"):null}).filter(Boolean));
 realAvail.set(t, Math.min(...[...sides].map(s=>s==="short"?g.availShort:g.availLong)));}
const hlVol=new Map(capRows.map(r=>[r.t,r.hlVol]));
console.log("\n# ПЕРЕЗАПУСК с ёмкостью по РЕАЛЬНО выбираемым сторонам (доля 1%, запас 5x)");
console.log("| капитал | имён у критика | APR критика | имён у меня | APR у меня |");
const capCrit=new Map(capRows.map(r=>[r.t,Math.min(r.avail,r.hlVol*0.01)]));
const capReal=new Map(full.map(t=>[t,Math.min(realAvail.get(t), (hlVol.get(t)??0)*0.01)]));
for (const capital of [10000,30000,50000,100000]) {
  const need=5*capital/3;
  const a=full.filter(t=>(capCrit.get(t)??0)>=need), b=full.filter(t=>(capReal.get(t)??0)>=need);
  const ra=a.length>=3?pc(walk({tokens:a,W:90,H:30,N:3,capital}).apr):"<3";
  const rb=b.length>=3?pc(walk({tokens:b,W:90,H:30,N:3,capital}).apr):"<3";
  console.log(`| $${capital} | ${a.length} | ${ra} | ${b.length} | ${rb} |`);
}
