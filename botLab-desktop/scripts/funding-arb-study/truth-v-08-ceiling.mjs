import {all,MAP,SP,apr} from "./truth-v-lib.mjs"; import fs from "node:fs";
const cap=JSON.parse(fs.readFileSync(`${SP}/truth-v-cap.json`,"utf8"));
const capBy=new Map(cap.map(r=>[r.t,Number(r.maxFundingFactorPerSecondLong)/1e30]));
const YEAR=8761, full=[...all.keys()].filter(t=>all.get(t).length===YEAR);
// помесячно: доля часов выше текущего протокольного max, и максимум |f|
const mon=new Map();
for(const t of full){ const c=capBy.get(t); if(!c) continue;
  for(const r of all.get(t)){ const m=r.ts.slice(0,7);
    const o=mon.get(m)||{n:0,ab:0,mx:0,eq:0}; 
    for(const v of [Math.abs(r.f_long),Math.abs(r.f_short)]){ o.n++; if(v>c*1.0001)o.ab++; if(v>o.mx)o.mx=v; if(Math.abs(v-c)/c<1e-9)o.eq++; }
    mon.set(m,o); }
}
console.log("месяц    часов*2   выше тек.max   максимум |f|      % год       ровно НА тек.max");
for(const [m,o] of [...mon].sort()) console.log(`${m}  ${String(o.n).padStart(7)}   ${(100*o.ab/o.n).toFixed(1).padStart(5)}%   ${o.mx.toExponential(3)}  ${apr(o.mx).toExponential(2).padStart(9)}   ${o.eq}`);
// ищем эмпирическую стену: самое частое значение |f| у каждого рынка (масс-точка)
console.log("\nмасс-точки: самое частое НЕнулевое значение |f| и сколько часов на нём (топ-20 рынков)");
const mp=[];
for(const t of full){ const cnt=new Map();
  for(const r of all.get(t)) for(const v of [Math.abs(r.f_long),Math.abs(r.f_short)]) if(v>0) cnt.set(v,(cnt.get(v)||0)+1);
  const [v,n]=[...cnt].sort((a,b)=>b[1]-a[1])[0];
  mp.push({t,v,n,cap:capBy.get(t),ratio:v/capBy.get(t)});
}
for(const r of mp.sort((a,b)=>b.n-a.n).slice(0,20))
  console.log(`  ${r.t.padEnd(9)} ${String(r.n).padStart(5)} часов на ${r.v.toExponential(4)} (${apr(r.v).toFixed(0)}% год)  = ${r.ratio.toFixed(2)}x от тек. протокол.max`);
// эмпирическая верхняя стена: доля рынков, у которых наблюдаемый годовой max ниже 1e-7
const mx=full.map(t=>({t,m:Math.max(...all.get(t).flatMap(r=>[Math.abs(r.f_long),Math.abs(r.f_short)]))})).sort((a,b)=>a.m-b.m);
console.log("\nнаблюдаемый годовой максимум |f| по рынкам, отсортировано:");
console.log(mx.map(r=>`${r.t}=${r.m.toExponential(2)}`).join(" "));
