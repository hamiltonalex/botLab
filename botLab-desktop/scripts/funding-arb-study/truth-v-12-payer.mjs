import {all,SP,apr} from "./truth-v-lib.mjs"; import fs from "node:fs";
const cap=JSON.parse(fs.readFileSync(`${SP}/truth-v-cap.json`,"utf8"));
const capBy=new Map(cap.map(r=>[r.t,Number(r.maxFundingFactorPerSecondLong)/1e30]));
const YEAR=8761, full=[...all.keys()].filter(t=>all.get(t).length===YEAR);
// гипотеза: потолок держит ПЛАТЯЩУЮ сторону (меньшую по модулю ставку), а не получающую
let payAbove=0,recvAbove=0,n=0, mnAll=[], mxAll=[];
const per=[];
for(const t of full){ const c=capBy.get(t); let pa=0,ra=0,m=0;
  for(const r of all.get(t)){ const a=Math.abs(r.f_long),b=Math.abs(r.f_short);
    const mn=Math.min(a,b), mx=Math.max(a,b); n++; m++;
    if(mn>c*1.0001){pa++;payAbove++;} if(mx>c*1.0001){ra++;recvAbove++;}
    mnAll.push(mn); }
  per.push({t,pa:100*pa/m,ra:100*ra/m,c}); }
console.log(`часов всего ${n}`);
console.log(`ПЛАТЯЩАЯ сторона (min|f|) выше протокольного max: ${payAbove} = ${(100*payAbove/n).toFixed(2)}%`);
console.log(`ПОЛУЧАЮЩАЯ сторона (max|f|) выше max:            ${recvAbove} = ${(100*recvAbove/n).toFixed(2)}%`);
mnAll.sort((a,b)=>a-b);
const Q=p=>mnAll[Math.floor(p*mnAll.length)];
console.log(`\nквантили min|f| (ставка платящей стороны):`);
for(const p of [0.5,0.9,0.99,0.999,0.9999,0.99999]) console.log(`  p${(100*p).toFixed(3).padEnd(8)} ${Q(p).toExponential(3)}  ${apr(Q(p)).toFixed(1)}% год`);
console.log(`  max      ${mnAll[mnAll.length-1].toExponential(3)}  ${apr(mnAll[mnAll.length-1]).toFixed(1)}% год`);
console.log(`\nхудшие 10 имён по доле часов, где ПЛАТЯЩАЯ сторона выше своего max:`);
for(const r of per.sort((a,b)=>b.pa-a.pa).slice(0,10)) console.log(`  ${r.t.padEnd(9)} платящая ${r.pa.toFixed(2)}%  получающая ${r.ra.toFixed(2)}%`);
// сколько имён держат потолок на платящей стороне почти всегда
console.log(`\nимён, где платящая сторона выше max реже чем в 5% часов: ${per.filter(r=>r.pa<5).length} из ${per.length}`);
