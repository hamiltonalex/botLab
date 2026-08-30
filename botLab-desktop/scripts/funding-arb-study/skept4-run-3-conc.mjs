// 3. Сколько НЕЗАВИСИМЫХ наблюдений и на скольких именах держится ответ.
import { TAB, PER, YRS, costRound } from "./run4-lib.mjs";
import { caps } from "./run4-grid.mjs";
const f = (x) => (x < 0 ? "-$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");
function sim({capital,N=3,K=8,sane=10,margin=1,hlVariant="correctedSqrt",gmxAdverse=false,sizer,drop=null}) {
  const led=[]; let held=new Map();
  for (let pi=0;pi<TAB.length;pi++){
    const hrs=PER[pi][1]-PER[pi][0];
    const cand=[...TAB[pi].entries()].filter(([t,d])=>Number.isFinite(d.peak)&&d.peak<=sane&&!(drop&&drop.has(t)))
      .map(([t,d])=>({t,...d})).sort((a,b)=>b.v-a.v);
    let left=capital; const now=new Map();
    for(const s of cand){ if(now.size>=K||left<=1)break;
      const o={hlVariant,gmxAdverse,margin,hlTrail:s.hlTrail};
      const hi=Math.min(caps(s.t,s.cfg,o),capital/N,left); if(!(hi>10))continue;
      const gEst=sizer==="causal"?s.v*hrs/8760:s.g1;
      let best=0,bv=-Infinity;
      for(let k=0;k<=400;k++){const S=10*Math.pow(hi/10,k/400); if(S>hi)break;
        const v=gEst*S-costRound(s.t,s.cfg,S,o).total; if(v>bv){bv=v;best=S;}}
      if(!(bv>0))continue;
      const prev=held.get(s.t+s.cfg);
      const c=(prev&&Math.abs(prev-best)/best<1e-9)?0:costRound(s.t,s.cfg,best,o).total;
      led.push({pi,t:s.t,size:best,net:s.g1*best-c,realAPR:s.g1*8760/hrs,hrs});
      now.set(s.t+s.cfg,best); left-=best; }
    held=now;
  }
  return led;
}
const W = PER.map(([a,b])=>(b-a)/8760);   // годовая доля каждого периода
function boot(led,seed=1){
  const per=Array.from({length:TAB.length},(_,i)=>led.filter(r=>r.pi===i).reduce((a,x)=>a+x.net,0));
  let s=seed; const rnd=()=>{s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff;};
  const out=[];
  for(let b=0;b<20000;b++){ let n=0,w=0;
    for(let k=0;k<per.length;k++){const j=Math.floor(rnd()*per.length); n+=per[j]; w+=W[j];}
    out.push(n/w); }
  out.sort((a,b)=>a-b);
  return {p5:out[1000],p50:out[10000],p95:out[19000],lo:out[500],hi:out[19500],
          pBelow25k:out.filter(x=>x<25000).length/out.length, per};
}
for (const [lbl,cfg] of [
  ["БАЗА, $1M, размер прогона (со знанием исхода)",{capital:1e6,sizer:"lookahead"}],
  ["БАЗА, $1M, ПРИЧИННЫЙ размер",{capital:1e6,sizer:"causal"}],
  ["ПРЕДЕЛЬНО 10%, $1M, размер прогона",{capital:1e6,sizer:"lookahead",margin:10,hlVariant:"raw",gmxAdverse:true,sane:5}],
  ["ПРЕДЕЛЬНО 10%, $1M, ПРИЧИННЫЙ размер",{capital:1e6,sizer:"causal",margin:10,hlVariant:"raw",gmxAdverse:true,sane:5}],
  ["КОНСЕРВ 20%, $300k, ПРИЧИННЫЙ размер",{capital:3e5,sizer:"causal",margin:5,hlVariant:"raw",gmxAdverse:true,sane:5}],
]) {
  const led=sim(cfg); const tot=led.reduce((a,b)=>a+b.net,0); const B=boot(led);
  const byT=new Map(); for(const r of led) byT.set(r.t,(byT.get(r.t)||0)+r.net);
  const srt=[...byT].sort((a,b)=>b[1]-a[1]);
  console.log(`\n## ${lbl}`);
  console.log(`  $/год ${f(tot/YRS)}; позиций ${led.length}; имён ${byT.size}`);
  console.log(`  помесячно: ${B.per.map(x=>f(x)).join(" | ")}`);
  console.log(`  бутстрап по 10 окнам: медиана ${f(B.p50)}, 90% ИД [${f(B.p5)} .. ${f(B.p95)}], 99% [${f(B.lo)} .. ${f(B.hi)}]`);
  console.log(`  вероятность оказаться НИЖЕ порога $25k: ${(100*B.pBelow25k).toFixed(1)}%`);
  console.log(`  топ-1 имя ${srt[0][0]} = ${(100*srt[0][1]/tot).toFixed(0)}% итога; топ-3 = ${(100*srt.slice(0,3).reduce((a,b)=>a+b[1],0)/tot).toFixed(0)}%; топ-5 = ${(100*srt.slice(0,5).reduce((a,b)=>a+b[1],0)/tot).toFixed(0)}%`);
  console.log(`  топ-5: ${srt.slice(0,5).map(([t,v])=>`${t} ${f(v/YRS)}/год`).join(", ")}`);
  const one=srt[0][0], three=new Set(srt.slice(0,3).map(x=>x[0]));
  console.log(`  БЕЗ топ-1 имени (пересобрано с нуля): ${f(sim({...cfg,drop:new Set([one])}).reduce((a,b)=>a+b.net,0)/YRS)}/год`);
  console.log(`  БЕЗ топ-3 имён (пересобрано с нуля): ${f(sim({...cfg,drop:three}).reduce((a,b)=>a+b.net,0)/YRS)}/год`);
  // вырожденные ставки, с ПРАВИЛЬНОЙ длиной периода
  const dg=led.filter(r=>r.realAPR>10).reduce((a,b)=>a+b.net,0);
  const dg3=led.filter(r=>r.realAPR>3).reduce((a,b)=>a+b.net,0);
  console.log(`  вклад позиций с реализованной ставкой >1000% годовых: ${(100*dg/tot).toFixed(0)}%; >300%: ${(100*dg3/tot).toFixed(0)}%`);
  console.log(`  ядро (реализ.<=300%): ${f((tot-dg3)/YRS)}/год`);
}
