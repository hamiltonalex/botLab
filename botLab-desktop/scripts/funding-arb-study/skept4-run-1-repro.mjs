// 1. Независимая нарезка: своя реализация портфельного цикла поверх ТЕХ ЖЕ TAB/costRound,
//    плюс инвентаризация того, что вообще стоит за ответом.
import { TAB, PER, YRS, CAP, costRound, costFlat, hlCapUsd, gmxRtBps, DEFAULT_COSTS, roundTripCost, med } from "./run4-lib.mjs";
import { run, GRID, caps } from "./run4-grid.mjs";
const f = (x) => (x < 0 ? "-$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");

console.log("## 0. Инвентарь прогона");
console.log(`периодов удержания: ${TAB.length}; окна:`);
PER.forEach(([a,b],i)=>console.log(`  п.${i+1}: часы ${a}..${b} (${b-a} ч = ${((b-a)/24).toFixed(1)} сут)`));
console.log(`YRS = ${YRS.toFixed(4)} (нормировка x${(1/YRS).toFixed(3)})`);
console.log(`сумма часов удержания = ${PER.reduce((a,[x,y])=>a+y-x,0)} ч; 0.7535 года`);
console.log(`имён в TAB по периодам: ${TAB.map(m=>m.size).join(",")}`);

// своя реализация, чтобы не переиспользовать run()
function mine({ capital, N=3, K=8, sane=10, margin=1, hlVariant="correctedSqrt", gmxAdverse=false, sizer="lookahead", holdH=720 }) {
  const led = []; let held = new Map(); let utilSum=0;
  for (let pi=0; pi<TAB.length; pi++) {
    const m = TAB[pi];
    const hrs = PER[pi][1]-PER[pi][0];
    const cand = [...m.entries()].filter(([,d])=>Number.isFinite(d.peak)&&d.peak<=sane)
      .map(([t,d])=>({t,...d})).sort((a,b)=>b.v-a.v);
    let left = capital; const now = new Map();
    for (const s of cand) {
      if (now.size>=K || left<=1) break;
      const o = {hlVariant,gmxAdverse,margin,hlTrail:s.hlTrail};
      const hi = Math.min(caps(s.t,s.cfg,o), capital/N, left);
      if (!(hi>10)) continue;
      // sizer: 'lookahead' = как в прогоне (знает реализованный g1);
      //        'causal'    = знает только обучающую оценку ставки
      const gEst = sizer==="causal" ? s.v * hrs/8760 : s.g1;
      let best=0, bv=-Infinity, bvTrue=0;
      for (let k=0;k<=400;k++){ const S=10*Math.pow(hi/10,k/400); if(S>hi) break;
        const v = gEst*S - costRound(s.t,s.cfg,S,o).total; if(v>bv){bv=v;best=S;} }
      if (!(bv>0)) continue;                       // решение о входе на той же оценке
      const prev = held.get(s.t+s.cfg);
      const c = (prev && Math.abs(prev-best)/best<1e-9) ? 0 : costRound(s.t,s.cfg,best,o).total;
      led.push({pi,t:s.t,cfg:s.cfg,size:best,gross:s.g1*best,cost:c,net:s.g1*best-c,realAPR:s.g1*8760/hrs,hrs});
      now.set(s.t+s.cfg,best); left-=best;
    }
    held=now; utilSum += (capital-left)/capital;
  }
  const net = led.reduce((a,b)=>a+b.net,0);
  return { led, usd: net/YRS, apr: net/capital/YRS, util: utilSum/TAB.length, pos: led.length,
           names: new Set(led.map(r=>r.t)).size };
}

console.log("\n## 1. Своя нарезка против run() прогона (режим econ, база)");
console.log("| капитал | run() $/год | моя $/год | расхождение |");
console.log("|---|---|---|---|");
for (const c of GRID) { const a = run({capital:c}); const b = mine({capital:c});
  console.log(`| ${f(c)} | ${f(a.usd)} | ${f(b.usd)} | ${(100*(b.usd-a.usd)/Math.abs(a.usd)).toFixed(2)}% |`); }

console.log("\n## 2. Таблица издержки круга, медиана по 63 именам (проверка шапки прогона)");
console.log("| S | плоская всего бп | новая всего бп | impact GMX бп | слиппедж HL бп |");
console.log("|---|---|---|---|---|");
const toks=[...CAP.keys()];
for (const S of [1000,10000,50000,100000,500000,1e6]) {
  const fl=[],nw=[],gi=[],hs=[];
  for (const t of toks) { const cfg="A";
    const c = costRound(t,cfg,S,{hlVariant:"correctedSqrt"});
    if (!Number.isFinite(c.total)) continue;
    fl.push(1e4*costFlat(S).total/S); nw.push(1e4*c.total/S);
    gi.push(-1e4*c.gmxImpactUsd/S); hs.push(1e4*c.hlSlipUsd/S); }
  console.log(`| ${f(S)} | ${med(fl).toFixed(1)} | ${med(nw).toFixed(1)} | ${(-med(gi)).toFixed(2)} | ${med(hs).toFixed(1)} | n=${nw.length}`);
}
