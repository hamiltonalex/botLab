// (а) другой прокси ликвидности HL (открытый интерес вместо суточного оборота)
// (б) ГЛАДКАЯ модель ёмкости: имя не выбрасывается, а урезается по размеру. Остаток капитала лежит.
import { all, full, YEAR, H1, scanTwoLeg, openPosition, accrueFromRows, closePosition, positionSummary,
         DEFAULT_COSTS, roundTripCost, capRows, pc, walk } from "./skept-cap-lib.mjs";
const W=90,H=30,N=3,trainH=W*H1,holdH=H*H1;
const per_=[];for(let i=trainH;i+24<=YEAR;i+=holdH){const te=Math.min(YEAR,i+holdH);if(te-i<24)break;per_.push([i,te]);}
const tab=per_.map(([i,te])=>{const m=new Map();
 for(const t of full){const rows=all.get(t);const sc=scanTwoLeg(rows.slice(i-trainH,i),{token:t});if(!sc)continue;
  const b=sc.chosen==="A"?sc.A:sc.B;const v=b.netMedian;if(!(v>0))continue;
  const w=rows.slice(i,te);const p=openPosition({strategy:"two",instrumentKey:t,config:sc.chosen,capital:1,leverage:1,nowMs:w[0].tsHour*1000,roundTripCost:0});
  accrueFromRows(p,w,w[w.length-1].tsHour*1000+3600000);closePosition(p,w[w.length-1].tsHour*1000+3600000);
  m.set(t,{cfg:sc.chosen,v,g1:positionSummary(p).grossPnl});}
 return m;});
const yrs=(per_[per_.length-1][1]-trainH)/8760;
const byT=new Map(capRows.map(r=>[r.t,r]));

// ЖЁСТКИЙ фильтр (как у критика): имя либо есть, либо нет; всегда слот = капитал/N
function hard(bottle, capital, margin=5){
  const slot=capital/N, rt=roundTripCost(DEFAULT_COSTS,slot,false);
  const ok=full.filter(t=>(bottle.get(t)??0)>=margin*slot);
  if(ok.length<N) return null;
  let gross=0,opens=0,held=new Set();
  for(const m of tab){const c=ok.filter(t=>m.has(t)).map(t=>({t,...m.get(t)})).sort((a,b)=>b.v-a.v).slice(0,N);
   for(const s of c){gross+=s.g1*slot;if(!held.has(s.t+s.cfg))opens++;} held=new Set(c.map(s=>s.t+s.cfg));}
  return {n:ok.length,apr:(gross-opens*rt)/capital/yrs};
}
// ГЛАДКАЯ модель: слот = min(капитал/N, ёмкость/margin). Недоразмещённое лежит в кэше под 0%.
// Позволяем добрать до K имён, чтобы капитал использовался; K = сколько влезет.
function soft(bottle, capital, margin=5, K=8){
  let gross=0,opens=0,fees=0,held=new Map(),deployedSum=0;
  for(const m of tab){
    const c=full.filter(t=>m.has(t)).map(t=>({t,...m.get(t)})).sort((a,b)=>b.v-a.v);
    let left=capital; const now=new Map();
    for(const s of c){ if(now.size>=K||left<=1) break;
      const cp=Math.min(capital/N,(bottle.get(s.t)??0)/margin, left);
      if(cp<capital/100) continue;                 // микро-позиции не открываем
      now.set(s.t+s.cfg,cp); left-=cp; gross+=s.g1*cp; }
    for(const [k,sz] of now) if(held.get(k)!==sz){ fees+=roundTripCost(DEFAULT_COSTS,sz,false); opens++; }
    deployedSum += (capital-left)/capital;
    held=now;
  }
  return {apr:(gross-fees)/capital/yrs, util:deployedSum/tab.length, opens};
}

const B = {
  "HL 1% оборота":  new Map(capRows.map(r=>[r.t,Math.min(r.avail,r.hlVol*0.01)])),
  "HL 1% OI":       new Map(capRows.map(r=>[r.t,Math.min(r.avail,r.hlOi*0.01)])),
  "HL 5% OI":       new Map(capRows.map(r=>[r.t,Math.min(r.avail,r.hlOi*0.05)])),
  "только GMX":     new Map(capRows.map(r=>[r.t,r.avail])),
};
console.log("# А. ВЫБОР ПРОКСИ ЛИКВИДНОСТИ HL. Жёсткий фильтр критика, запас 5x.");
console.log("| капитал | " + Object.keys(B).join(" | ") + " |");
for (const capital of [10000,30000,50000,100000,300000]) {
  const cells=Object.values(B).map(b=>{const r=hard(b,capital);return r?`${r.n}им ${pc(r.apr)} $${(r.apr*capital).toFixed(0)}`:"<3 имён";});
  console.log(`| $${capital} | ${cells.join(" | ")} |`);
}
console.log("\n# Б. ГЛАДКАЯ модель: имя не выбрасывается, а УРЕЗАЕТСЯ по размеру (до 8 имён, остаток в кэше)");
console.log("| капитал | " + Object.keys(B).map(k=>k+" (APR / $/год / загрузка)").join(" | ") + " |");
for (const capital of [10000,30000,100000,300000,1000000]) {
  const cells=Object.values(B).map(b=>{const r=soft(b,capital);return `${pc(r.apr)} $${(r.apr*capital).toFixed(0)} ${(100*r.util).toFixed(0)}%`;});
  console.log(`| $${capital} | ${cells.join(" | ")} |`);
}
console.log("\n# В. ГДЕ РЕАЛЬНО МАКСИМУМ ДОЛЛАРОВ (гладкая модель, HL 1% оборота, запас 5x)");
let best=null;
for (const capital of [10000,20000,30000,50000,75000,100000,150000,200000,300000,500000,1000000,2000000]) {
  const r=soft(B["HL 1% оборота"],capital);
  const u=r.apr*capital; if(!best||u>best.u)best={capital,u,apr:r.apr,util:r.util};
  console.log(`  $${String(capital).padStart(8)}  APR ${pc(r.apr).padStart(8)}  $/год ${u.toFixed(0).padStart(8)}  загрузка ${(100*r.util).toFixed(0)}%`);
}
console.log(`МАКСИМУМ: $${best.u.toFixed(0)}/год при капитале $${best.capital} (${pc(best.apr)}, загрузка ${(100*best.util).toFixed(0)}%)`);
