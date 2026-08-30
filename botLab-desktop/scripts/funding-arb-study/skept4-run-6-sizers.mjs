// 6. Заглядывание разложено на две части (вход и размер), и причинный размер взят НЕ одним
//    способом, чтобы вывод не зависел от одной произвольной замены.
//    Плюс: годовая нормировка ставки позиции в диагностиках прогона (run4-5/run4-8) считает
//    8760/720 для ВСЕХ периодов, тогда как период 10 длится 121 час.
import { TAB, PER, YRS, costRound } from "./run4-lib.mjs";
import { caps } from "./run4-grid.mjs";
const f=(x)=>(x<0?"-$":"$")+Math.round(Math.abs(x)).toLocaleString("en-US");
function sim({capital,N=3,K=8,sane=10,margin=1,hlVariant="correctedSqrt",gmxAdverse=false,gate,size}){
  const led=[]; let held=new Map();
  for(let pi=0;pi<TAB.length;pi++){ const hrs=PER[pi][1]-PER[pi][0];
    const cand=[...TAB[pi].entries()].filter(([,d])=>Number.isFinite(d.peak)&&d.peak<=sane).map(([t,d])=>({t,...d})).sort((a,b)=>b.v-a.v);
    let left=capital; const now=new Map();
    for(const s of cand){ if(now.size>=K||left<=1)break;
      const o={hlVariant,gmxAdverse,margin,hlTrail:s.hlTrail};
      const hi=Math.min(caps(s.t,s.cfg,o),capital/N,left); if(!(hi>10))continue;
      const gCaus=s.v*hrs/8760, gTrue=s.g1;
      const gGate = gate==="causal"?gCaus:gTrue;
      const gSize = size==="causal"?gCaus : size==="half"?0.5*gCaus : size==="mean"?s.vm*hrs/8760 : gTrue;
      let best=0,bv=-Infinity;
      if(size==="maxout"){ best=hi; bv=gGate*hi-costRound(s.t,s.cfg,hi,o).total; }
      else { for(let k=0;k<=400;k++){const S=10*Math.pow(hi/10,k/400); if(S>hi)break;
        const v=gSize*S-costRound(s.t,s.cfg,S,o).total; if(v>bv){bv=v;best=S;}} }
      const gateVal = gGate*best - costRound(s.t,s.cfg,best,o).total;
      if(!(gateVal>0))continue;
      const prev=held.get(s.t+s.cfg);
      const c=(prev&&Math.abs(prev-best)/best<1e-9)?0:costRound(s.t,s.cfg,best,o).total;
      led.push({pi,t:s.t,size:best,net:s.g1*best-c,realAPR:s.g1*8760/hrs,realAPRbug:s.g1*8760/720});
      now.set(s.t+s.cfg,best); left-=best; }
    held=now; }
  return led;
}
const TIGHT={margin:10,hlVariant:"raw",gmxAdverse:true,sane:5};
const V=(cfg)=>f(sim(cfg).reduce((a,b)=>a+b.net,0)/YRS);
console.log("## 6.1 Что именно даёт заглядывание: вход и размер по отдельности (капитал $1M)");
console.log("| вход / размер | БАЗА | ПРЕДЕЛЬНО 10% |");
console.log("|---|---|---|");
for (const [lbl,gate,size] of [
  ["будущее / будущее (это прогон)","look","look"],
  ["будущее / причинный","look","causal"],
  ["причинный / будущее","causal","look"],
  ["причинный / причинный","causal","causal"],
]) console.log(`| ${lbl} | ${V({capital:1e6,gate,size})} | ${V({capital:1e6,gate,size,...TIGHT})} |`);

console.log("\n## 6.2 Причинный размер взят четырьмя разными способами (капитал $1M, вход причинный)");
console.log("| правило размера | БАЗА | ПРЕДЕЛЬНО 10% |");
console.log("|---|---|---|");
for (const [lbl,size] of [
  ["argmax по обучающей МЕДИАНЕ ставки","causal"],
  ["argmax по половине обучающей оценки (усадка)","half"],
  ["взять весь доступный потолок (без оптимизации)","maxout"],
]) console.log(`| ${lbl} | ${V({capital:1e6,gate:"causal",size})} | ${V({capital:1e6,gate:"causal",size,...TIGHT})} |`);

console.log("\n## 6.3 Ошибка годовой нормировки ставки позиции в диагностиках прогона");
const led=sim({capital:1e6,gate:"look",size:"look"});
const tot=led.reduce((a,b)=>a+b.net,0);
const p10=led.filter(r=>r.pi===9);
console.log(`  период 10 длится 121 ч, но run4-5/run4-8 нормируют его как 720 ч (занижение ставки в 5.95 раза)`);
console.log(`  позиций в периоде 10: ${p10.length}, их чистый вклад ${f(p10.reduce((a,b)=>a+b.net,0)/YRS)}/год`);
const cut=(k,fld)=>led.filter(r=>r[fld]<=k).reduce((a,b)=>a+b.net,0)/YRS;
console.log(`  "ядро реализ.<=300%": как считает прогон ${f(cut(3,"realAPRbug"))}/год; с ПРАВИЛЬНОЙ длиной периода ${f(cut(3,"realAPR"))}/год`);
console.log(`  "без вырожденных >1000%": как считает прогон ${f(cut(10,"realAPRbug"))}/год; правильно ${f(cut(10,"realAPR"))}/год`);
console.log(`  всего ${f(tot/YRS)}/год`);
