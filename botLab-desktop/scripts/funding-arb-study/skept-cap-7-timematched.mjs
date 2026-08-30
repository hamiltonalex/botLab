// Ёмкость, ПРИВЯЗАННАЯ КО ВРЕМЕНИ: для каждого окна удержания нога HL меряется по медианному
// суточному обороту в ПРЕДШЕСТВУЮЩЕМ обучающем окне (причинно, без заглядывания вперёд).
// Нога GMX остаётся снимком 2026-08-30 (истории availableLiquidity у нас нет) - это признаётся.
import fs from "node:fs";
import { all, full, YEAR, H1, scanTwoLeg, openPosition, accrueFromRows, closePosition, positionSummary,
         DEFAULT_COSTS, roundTripCost, capRows, pc, SP } from "./skept-cap-lib.mjs";
const vol=JSON.parse(fs.readFileSync(`${SP}/skept-hlvol.json`,"utf8"));
const byT=new Map(capRows.map(r=>[r.t,r]));
const W=90,H=30,N=3,trainH=W*H1,holdH=H*H1;
const per_=[];for(let i=trainH;i+24<=YEAR;i+=holdH){const te=Math.min(YEAR,i+holdH);if(te-i<24)break;per_.push([i,te]);}
const med=(xs)=>{const a=xs.slice().sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):NaN;};

const tab=per_.map(([i,te])=>{
  const t0=all.get(full[0])[i-trainH].tsHour*1000, t1=all.get(full[0])[i].tsHour*1000;
  const m=new Map();
  for(const t of full){
    const rows=all.get(t);const sc=scanTwoLeg(rows.slice(i-trainH,i),{token:t});if(!sc)continue;
    const b=sc.chosen==="A"?sc.A:sc.B;const v=b.netMedian;if(!(v>0))continue;
    const w=rows.slice(i,te);const p=openPosition({strategy:"two",instrumentKey:t,config:sc.chosen,capital:1,leverage:1,nowMs:w[0].tsHour*1000,roundTripCost:0});
    accrueFromRows(p,w,w[w.length-1].tsHour*1000+3600000);closePosition(p,w[w.length-1].tsHour*1000+3600000);
    // оборот HL в обучающем окне (медиана суток), причинно
    const vs=(vol[t]||[]).filter(c=>c.t>=t0&&c.t<t1).map(c=>c.ntl).filter(Number.isFinite);
    m.set(t,{cfg:sc.chosen,v,g1:positionSummary(p).grossPnl,hlTrail:vs.length>=10?med(vs):NaN});
  }
  return m;});
const yrs=(per_[per_.length-1][1]-trainH)/8760;

function run({share=0.01,margin=5,timeMatched=true,soft=false,K=8,capital}) {
  const slotFull=capital/N, rtF=roundTripCost(DEFAULT_COSTS,slotFull,false);
  let gross=0,fees=0,opens=0,held=new Map(),util=0,namesSeen=new Set();
  for(const m of tab){
    const bot=(t)=>{const r=byT.get(t);const hv=timeMatched?m.get(t).hlTrail:r.hlVol;
      return Math.min(r.avail, (Number.isFinite(hv)?hv:0)*share);};
    let cand=full.filter(t=>m.has(t)).map(t=>({t,...m.get(t),b:bot(t)})).sort((a,b)=>b.v-a.v);
    const now=new Map();
    if(!soft){
      cand=cand.filter(s=>s.b>=margin*slotFull).slice(0,N);
      for(const s of cand){ now.set(s.t+s.cfg,slotFull); gross+=s.g1*slotFull; namesSeen.add(s.t); }
      util+= now.size*slotFull/capital;
    } else {
      let left=capital;
      for(const s of cand){ if(now.size>=K||left<=1)break;
        const cp=Math.min(slotFull, s.b/margin, left); if(cp<capital/100)continue;
        now.set(s.t+s.cfg,cp); left-=cp; gross+=s.g1*cp; namesSeen.add(s.t); }
      util+=(capital-left)/capital;
    }
    for(const [k,sz] of now) if(held.get(k)!==sz){ fees+=roundTripCost(DEFAULT_COSTS,sz,false); opens++; }
    held=now;
  }
  return {apr:(gross-fees)/capital/yrs, util:util/tab.length, names:namesSeen.size};
}

console.log("# ЁМКОСТЬ ПО ВРЕМЕНИ ПЕРИОДА против СНИМКА 2026-08-30 (доля 1%, запас 5x, жёсткий фильтр критика)");
console.log("| капитал | снимок (у критика) | по обороту самого периода | разница $/год |");
for (const capital of [10000,30000,50000,100000,200000]) {
  const a=run({capital,timeMatched:false}), b=run({capital,timeMatched:true});
  console.log(`| $${capital} | ${pc(a.apr)} $${(a.apr*capital).toFixed(0)} | ${pc(b.apr)} $${(b.apr*capital).toFixed(0)} | ${((b.apr-a.apr)*capital).toFixed(0)} |`);
}
console.log("\n# ТО ЖЕ, но ГЛАДКАЯ модель (урезание размера вместо выбрасывания имени), K=8");
console.log("| капитал | снимок | по периоду | загрузка по периоду |");
for (const capital of [10000,30000,100000,300000,1000000]) {
  const a=run({capital,timeMatched:false,soft:true}), b=run({capital,timeMatched:true,soft:true});
  console.log(`| $${capital} | ${pc(a.apr)} $${(a.apr*capital).toFixed(0)} | ${pc(b.apr)} $${(b.apr*capital).toFixed(0)} | ${(100*b.util).toFixed(0)}% |`);
}
console.log("\n# ЧУВСТВИТЕЛЬНОСТЬ ГЛАДКОЙ МОДЕЛИ К ШИРИНЕ K (ёмкость по периоду, 1%/5x)");
console.log("| капитал | K=3 | K=5 | K=8 | K=12 |");
for (const capital of [30000,100000,300000]) {
  const c=[3,5,8,12].map(K=>{const r=run({capital,timeMatched:true,soft:true,K});return `${pc(r.apr)} $${(r.apr*capital).toFixed(0)} (${(100*r.util).toFixed(0)}%)`;});
  console.log(`| $${capital} | ${c.join(" | ")} |`);
}
console.log("\n# ГДЕ МАКСИМУМ ДОЛЛАРОВ (гладкая, ёмкость по периоду, K=8, 1%/5x)");
let best=null;
for (const capital of [10000,30000,50000,100000,200000,300000,500000,1000000,2000000,5000000]) {
  const r=run({capital,timeMatched:true,soft:true});
  const u=r.apr*capital; if(!best||u>best.u)best={capital,u,apr:r.apr};
  console.log(`  $${String(capital).padStart(9)}  APR ${pc(r.apr).padStart(8)}  $/год ${u.toFixed(0).padStart(9)}  загрузка ${(100*r.util).toFixed(0)}%`);
}
console.log(`МАКСИМУМ: $${best.u.toFixed(0)}/год при $${best.capital} (${pc(best.apr)})`);
