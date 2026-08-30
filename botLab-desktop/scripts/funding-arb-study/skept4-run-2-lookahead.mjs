// 2. ЗАГЛЯДЫВАНИЕ В БУДУЩЕЕ В ПРАВИЛЕ РАЗМЕРА.
// bestSize() максимизирует g1*S - cost(S), где g1 = РЕАЛИЗОВАННЫЙ валовый результат окна
// УДЕРЖАНИЯ (positionSummary(p).grossPnl на единичный ноционал). Значит правило размера
// и решение о входе (`if bv<=0 -> размер 0`) знают исход заранее.
import { TAB, PER, YRS, costRound } from "./run4-lib.mjs";
import { caps, GRID } from "./run4-grid.mjs";
const f = (x) => (x < 0 ? "-$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");

function sim({ capital, N=3, K=8, sane=10, margin=1, hlVariant="correctedSqrt", gmxAdverse=false, sizer }) {
  const led=[]; let held=new Map(); let util=0, skipped=0, skipGross=0;
  for (let pi=0; pi<TAB.length; pi++) {
    const hrs = PER[pi][1]-PER[pi][0];
    const cand=[...TAB[pi].entries()].filter(([,d])=>Number.isFinite(d.peak)&&d.peak<=sane)
      .map(([t,d])=>({t,...d})).sort((a,b)=>b.v-a.v);
    let left=capital; const now=new Map();
    for (const s of cand) {
      if (now.size>=K||left<=1) break;
      const o={hlVariant,gmxAdverse,margin,hlTrail:s.hlTrail};
      const hi=Math.min(caps(s.t,s.cfg,o),capital/N,left); if(!(hi>10)) continue;
      const gEst = sizer==="causal" ? s.v*hrs/8760 : s.g1;
      let best=0,bv=-Infinity;
      for(let k=0;k<=400;k++){const S=10*Math.pow(hi/10,k/400); if(S>hi)break;
        const v=gEst*S-costRound(s.t,s.cfg,S,o).total; if(v>bv){bv=v;best=S;}}
      if(!(bv>0)){ if(sizer!=="causal"){skipped++; skipGross+=s.g1*hi;} continue; }
      const prev=held.get(s.t+s.cfg);
      const c=(prev&&Math.abs(prev-best)/best<1e-9)?0:costRound(s.t,s.cfg,best,o).total;
      led.push({pi,t:s.t,cfg:s.cfg,size:best,gross:s.g1*best,cost:c,net:s.g1*best-c,hrs,
                realAPR:s.g1*8760/hrs, trainAPR:s.v});
      now.set(s.t+s.cfg,best); left-=best;
    }
    held=now; util+=(capital-left)/capital;
  }
  const net=led.reduce((a,b)=>a+b.net,0);
  return {led, usd:net/YRS, apr:net/capital/YRS, util:util/TAB.length, pos:led.length, skipped, skipGross};
}

console.log("## 2.1 Правило размера, знающее будущее, против причинного (всё остальное то же)");
console.log("| капитал | прогон (g1 из окна удержания) | причинный (обучающая ставка) | сдвиг |");
console.log("|---|---|---|---|");
for (const c of GRID) {
  const a=sim({capital:c,sizer:"lookahead"}), b=sim({capital:c,sizer:"causal"});
  console.log(`| ${f(c)} | ${f(a.usd)} | ${f(b.usd)} | ${((b.usd-a.usd)/Math.abs(a.usd)*100).toFixed(0)}% |`);
}

console.log("\n## 2.2 Сколько кандидатов правило ОТБРОСИЛО, зная что они убыточны");
for (const c of [300000,1000000]) {
  const a=sim({capital:c,sizer:"lookahead"});
  console.log(`  капитал ${f(c)}: взято ${a.pos} позиций, отброшено по знанию исхода ${a.skipped}`);
  console.log(`    доля позиций с ОТРИЦАТЕЛЬНЫМ реализованным валом среди взятых: ${a.led.filter(r=>r.gross<=0).length}/${a.led.length}`);
  const b=sim({capital:c,sizer:"causal"});
  console.log(`    причинный режим: взято ${b.pos}, из них с отрицательным реализованным валом ${b.led.filter(r=>r.gross<=0).length} (${(100*b.led.filter(r=>r.gross<=0).length/b.pos).toFixed(0)}%)`);
}

console.log("\n## 2.3 Помесячно, причинное правило размера, капитал $1M и $300k");
for (const c of [300000,1000000]) {
  const b=sim({capital:c,sizer:"causal"});
  const per=Array.from({length:TAB.length},(_,i)=>b.led.filter(r=>r.pi===i).reduce((a,x)=>a+x.net,0));
  console.log(`  ${f(c)}: ${per.map(x=>f(x)).join(" | ")}`);
  console.log(`    итог ${f(per.reduce((a,x)=>a+x,0)/YRS)}/год, положительных периодов ${per.filter(x=>x>0).length}/${per.length}`);
  const s=per.slice().sort((x,y)=>y-x); const tot=per.reduce((a,x)=>a+x,0);
  console.log(`    без лучшего периода ${f((tot-s[0])/YRS)}/год; доля лучшего ${(100*s[0]/tot).toFixed(0)}%`);
}

console.log("\n## 2.4 Плато при причинном размере, включая жёсткие углы");
const MODES=[["БАЗА",{}],["СРЕДНЕ 50%",{margin:2}],["КОНСЕРВ 20%",{margin:5,hlVariant:"raw",gmxAdverse:true,sane:5}],["ПРЕДЕЛЬНО 10%",{margin:10,hlVariant:"raw",gmxAdverse:true,sane:5}]];
const G=[100000,300000,1000000,3000000,10000000,30000000];
console.log("| режим | " + G.map(f).join(" | ") + " |");
console.log("|" + "---|".repeat(G.length+1));
for (const [lbl,o] of MODES) {
  console.log(`| ${lbl} | ` + G.map(c=>f(sim({capital:c,sizer:"causal",...o}).usd)).join(" | ") + " |");
}
