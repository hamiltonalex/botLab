// 5. Плато или зубец. Плотная сетка капитала, унимодальность, и честный учёт капитала под ДВЕ ноги.
import { TAB, PER, YRS, costRound } from "./run4-lib.mjs";
import { caps } from "./run4-grid.mjs";
const f=(x)=>(x<0?"-$":"$")+Math.round(Math.abs(x)).toLocaleString("en-US");
function sim({capital,N=3,K=8,sane=10,margin=1,hlVariant="correctedSqrt",gmxAdverse=false,sizer,legs=1}){
  const led=[]; let held=new Map(); let util=0;
  const budget=capital/legs;                     // legs=2: ноционал S требует S на GMX и S на HL
  for(let pi=0;pi<TAB.length;pi++){ const hrs=PER[pi][1]-PER[pi][0];
    const cand=[...TAB[pi].entries()].filter(([,d])=>Number.isFinite(d.peak)&&d.peak<=sane).map(([t,d])=>({t,...d})).sort((a,b)=>b.v-a.v);
    let left=budget; const now=new Map();
    for(const s of cand){ if(now.size>=K||left<=1)break;
      const o={hlVariant,gmxAdverse,margin,hlTrail:s.hlTrail};
      const hi=Math.min(caps(s.t,s.cfg,o),budget/N,left); if(!(hi>10))continue;
      const gEst=sizer==="causal"?s.v*hrs/8760:s.g1;
      let best=0,bv=-Infinity;
      for(let k=0;k<=400;k++){const S=10*Math.pow(hi/10,k/400); if(S>hi)break;
        const v=gEst*S-costRound(s.t,s.cfg,S,o).total; if(v>bv){bv=v;best=S;}}
      if(!(bv>0))continue;
      const prev=held.get(s.t+s.cfg);
      const c=(prev&&Math.abs(prev-best)/best<1e-9)?0:costRound(s.t,s.cfg,best,o).total;
      led.push({pi,t:s.t,net:s.g1*best-c}); now.set(s.t+s.cfg,best); left-=best; }
    held=now; util+=(budget-left)/budget; }
  const net=led.reduce((a,b)=>a+b.net,0);
  return {usd:net/YRS, util:util/TAB.length, pos:led.length};
}
const G=[];for(let e=4;e<=7.5;e+=0.125)G.push(Math.round(Math.pow(10,e)));
console.log("## Плотная сетка капитала, $/год (K=8, N=3)");
console.log("| капитал | БАЗА, размер прогона | БАЗА, причинный | ПРЕДЕЛЬНО 10%, размер прогона | ПРЕДЕЛЬНО 10%, причинный |");
console.log("|---|---|---|---|---|");
const cols=[{sizer:"lookahead"},{sizer:"causal"},
            {sizer:"lookahead",margin:10,hlVariant:"raw",gmxAdverse:true,sane:5},
            {sizer:"causal",margin:10,hlVariant:"raw",gmxAdverse:true,sane:5}];
const series=cols.map(()=>[]);
for(const c of G){ const vals=cols.map((o,i)=>{const r=sim({capital:c,...o}); series[i].push(r.usd); return r.usd;});
  console.log(`| ${f(c)} | ${vals.map(f).join(" | ")} |`); }
console.log("\n## Унимодальность: число смен направления по плотной сетке (>1% шага)");
cols.forEach((o,i)=>{ const s=series[i]; let up=0,dn=0,flips=0,prev=0;
  for(let k=1;k<s.length;k++){ const d=s[k]-s[k-1]; if(Math.abs(d)<0.01*Math.abs(s[k-1]))continue;
    const sg=Math.sign(d); if(prev&&sg!==prev)flips++; prev=sg; if(sg>0)up++;else dn++; }
  const mx=Math.max(...s), im=s.indexOf(mx);
  console.log(`  колонка ${i+1}: максимум ${f(mx)} при ${f(G[im])}; шагов вверх ${up}, вниз ${dn}, СМЕН НАПРАВЛЕНИЯ ${flips}; на конце сетки ${f(s[s.length-1])} (${(100*s[s.length-1]/mx).toFixed(0)}% пика)`);
});
console.log("\n## Капитал под ДВЕ ноги (ноционал S требует S залога на GMX и S на HL при 1x)");
console.log("| капитал | БАЗА legs=1 | БАЗА legs=2 | ПРЕДЕЛЬНО legs=1 | ПРЕДЕЛЬНО legs=2 |");
console.log("|---|---|---|---|---|");
for(const c of [1e5,3e5,1e6,3e6,1e7]) {
  const a=sim({capital:c,sizer:"causal"}), b=sim({capital:c,sizer:"causal",legs:2});
  const d=sim({capital:c,sizer:"causal",margin:10,hlVariant:"raw",gmxAdverse:true,sane:5});
  const e=sim({capital:c,sizer:"causal",margin:10,hlVariant:"raw",gmxAdverse:true,sane:5,legs:2});
  console.log(`| ${f(c)} | ${f(a.usd)} | ${f(b.usd)} | ${f(d.usd)} | ${f(e.usd)} |`);
}
