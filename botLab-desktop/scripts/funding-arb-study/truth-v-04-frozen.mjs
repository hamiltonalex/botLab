import {all,MAP,SP,apr} from "./truth-v-lib.mjs"; import fs from "node:fs";
const cap=JSON.parse(fs.readFileSync(`${SP}/truth-v-cap.json`,"utf8"));
const capBy=new Map(cap.map(r=>[r.t,Number(r.maxFundingFactorPerSecondLong)/1e30]));
const YEAR=8761, MINRUN=Number(process.env.MINRUN||6);
const full=[...all.keys()].filter(t=>all.get(t).length===YEAR);
const runs=[];
for(const t of full){
  const rows=all.get(t);
  let s=0;
  for(let i=1;i<=rows.length;i++){
    const same = i<rows.length && rows[i].f_long===rows[s].f_long && rows[i].f_short===rows[s].f_short;
    if(!same){ const n=i-s; if(n>=MINRUN) runs.push({t,s,e:i-1,n,v:rows[s].f_long,vs:rows[s].f_short,t0:rows[s].ts,t1:rows[i-1].ts,ts0:rows[s].tsHour,ts1:rows[i-1].tsHour,hlN:new Set(rows.slice(s,i).map(r=>r.hl_rate)).size}); s=i; }
  }
}
runs.sort((a,b)=>b.n-a.n);
const byTok=new Map();
for(const r of runs){ const o=byTok.get(r.t)||{n:0,h:0,max:0}; o.n++; o.h+=r.n; o.max=Math.max(o.max,r.n); byTok.set(r.t,o); }
const totH=full.length*YEAR;
const frozH=[...byTok.values()].reduce((a,b)=>a+b.h,0);
console.log(`ЗАМОРОЖЕННЫЕ СЕРИИ (>=${MINRUN} часов подряд с побитово равными f_long И f_short)`);
console.log(`серий: ${runs.length}, имён с сериями: ${byTok.size} из ${full.length}`);
console.log(`часов внутри серий: ${frozH} из ${totH} = ${(100*frozH/totH).toFixed(2)}%`);
console.log(`\nтоп-25 серий по длине:`);
console.log("токен     часов  начало             конец              f_long          % год     |f|/протокол.max  разных hl_rate");
for(const r of runs.slice(0,25)){
  const c=capBy.get(r.t);
  console.log(`${r.t.padEnd(9)} ${String(r.n).padStart(5)}  ${r.t0.slice(0,16)}  ${r.t1.slice(0,16)}  ${r.v.toExponential(4).padStart(13)}  ${apr(r.v).toFixed(1).padStart(8)}  ${(Math.abs(r.v)/c).toFixed(2).padStart(8)}x        ${r.hlN}`);
}
fs.writeFileSync(`${SP}/truth-v-runs.json`,JSON.stringify(runs,null,0));
// сколько замороженных серий стоит НА уровне, который является максимумом |f| для этого рынка за год
console.log(`\nдиагноз серий: стоит ли значение на локальном максимуме рынка?`);
let atMax=0, notMax=0;
for(const r of runs){
  const rows=all.get(r.t);
  const yearMax=Math.max(...rows.map(x=>Math.abs(x.f_long)));
  if(Math.abs(r.v)>=0.999*yearMax) atMax++; else notMax++;
}
console.log(`  на годовом максимуме |f_long| рынка: ${atMax}; ниже него: ${notMax}`);
