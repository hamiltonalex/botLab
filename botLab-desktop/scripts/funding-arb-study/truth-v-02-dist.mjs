import {all,MAP,SP,apr} from "./truth-v-lib.mjs"; import fs from "node:fs";
const cap=JSON.parse(fs.readFileSync(`${SP}/truth-v-cap.json`,"utf8"));
const capBy=new Map(cap.map(r=>[r.t,{maxL:Number(r.maxFundingFactorPerSecondLong)/1e30,maxS:Number(r.maxFundingFactorPerSecondShort)/1e30,minL:Number(r.minFundingFactorPerSecondLong)/1e30}]));
const YEAR=8761;
const full=[...all.keys()].filter(t=>all.get(t).length===YEAR);
console.log("имён с полным годом:",full.length);
// глобальное распределение |f| (long и short, оба)
const vals=[];
let nAboveMax=0,nTot=0,atMaxL=0;
const perTok=[];
for(const t of full){
  const c=capBy.get(t); const rows=all.get(t);
  let above=0, hitL=0, hitS=0, mx=0;
  for(const r of rows){
    for(const [v,mm] of [[Math.abs(r.f_long),c?.maxL],[Math.abs(r.f_short),c?.maxS]]){
      vals.push(v); nTot++;
      if(v>mx) mx=v;
      if(c&&v>mm*1.0001) above++;
      if(c&&Math.abs(v-mm)/mm<1e-6) hitL++;
    }
  }
  nAboveMax+=above;
  perTok.push({t,above,pct:100*above/(rows.length*2),hit:hitL,max:mx,capMax:c?.maxL});
}
vals.sort((a,b)=>a-b);
const Q=p=>vals[Math.min(vals.length-1,Math.floor(p*vals.length))];
console.log(`\nвсего значений |f| (long+short): ${nTot}`);
console.log("квантили |f| в 1/с и % годовых:");
for(const p of [0.5,0.9,0.95,0.99,0.995,0.999,0.9995,0.9999,0.99999,1]){
  const v=Q(p===1?0.999999999:p);
  console.log(`  p${(100*p).toString().padEnd(7)} ${v.toExponential(4)}   ${apr(v).toFixed(1)}% год`);
}
console.log(`максимум ${vals[vals.length-1].toExponential(4)} = ${apr(vals[vals.length-1]).toExponential(3)}% год`);
console.log(`\nчасов выше ТЕКУЩЕГО протокольного max своего рынка: ${nAboveMax} из ${nTot} = ${(100*nAboveMax/nTot).toFixed(2)}%`);
// гистограмма по декадам
const dec=new Map();
for(const v of vals){ const d=v===0?"нуль":Math.floor(Math.log10(v)); dec.set(d,(dec.get(d)||0)+1); }
console.log("\nдекады |f|:");
for(const [d,n] of [...dec].sort((a,b)=>(a[0]==="нуль"?-99:a[0])-(b[0]==="нуль"?-99:b[0])))
  console.log(`  ${d==="нуль"?"= 0      ":`1e${d}..1e${d+1}`}  ${n.toString().padStart(7)}  ${(100*n/nTot).toFixed(3)}%`);
console.log("\nтоп-15 имён по доле часов выше своего протокольного max:");
for(const r of perTok.sort((a,b)=>b.pct-a.pct).slice(0,15))
  console.log(`  ${r.t.padEnd(9)} ${r.pct.toFixed(2).padStart(6)}%  наблюд.max=${r.max.toExponential(3)} (${apr(r.max).toExponential(2)}% год)  протокол.max=${r.capMax?.toExponential(3)} (во сколько выше: ${(r.max/r.capMax).toExponential(2)}x)`);
fs.writeFileSync(`${SP}/truth-v-perTok.json`,JSON.stringify(perTok,null,1));
