// Почему рост издержки поднимает доход: издержка отсеивает мелкие ставки и высвобождает
// капитал под РЕАЛИЗОВАННО вырожденные. Смотрим состав портфеля при 0 и при -100 бп.
import { run } from "./skept4-model-5-grid.mjs";
import { hlRtBps } from "./skept4-model-5-lib.mjs";
import { DEFAULT_COSTS, roundTripCost } from "./run4-lib.mjs";
const f=x=>"$"+Math.round(x).toLocaleString("en-US");
const NOIMP={...DEFAULT_COSTS,gmxImpact:0};
const mk=bps=>(t,cfg,S,o)=>{const base=roundTripCost(NOIMP,S,false);
  const g=-(bps/1e4)*S,h=(hlRtBps(t,o.hlVariant,S)/1e4)*S;
  return {total:base+g+h,base,gmxImpactUsd:g,hlSlipUsd:h,gmxBps:bps};};
for(const bps of [0,-100]){
  const dump=[]; const r=run({capital:1000000,cf:mk(bps),dump});
  const g=dump.map(p=>({k:p.t+"/"+p.cfg,gross:p.g1*p.size,size:p.size,apr:p.g1*(8760/720)}));
  const tot=g.reduce((s,x)=>s+x.gross,0);
  const by={}; for(const x of g) by[x.k]=(by[x.k]||0)+x.gross;
  const top=Object.entries(by).sort((a,b)=>b[1]-a[1]).slice(0,6);
  console.log(`\n== impact ${bps} бп: позиций ${dump.length}, брутто ${f(tot)}, чистыми ${f(r.usd*1)} /год`);
  console.log("  топ-6 имён по брутто: "+top.map(([k,v])=>`${k} ${f(v)} (${(100*v/tot).toFixed(0)}%)`).join(", "));
  console.log(`  доля брутто у топ-5 позиций: ${(100*g.slice().sort((a,b)=>b.gross-a.gross).slice(0,5).reduce((s,x)=>s+x.gross,0)/tot).toFixed(0)}%`);
  const deg=g.filter(x=>x.apr>10); // реализованная годовая ставка выше 1000%
  console.log(`  позиций с реализованной ставкой >1000% годовых: ${deg.length}, их доля брутто ${(100*deg.reduce((s,x)=>s+x.gross,0)/tot).toFixed(0)}%`);
  const sz=g.map(x=>x.size).sort((a,b)=>a-b);
  console.log(`  медианный размер ${f(sz[Math.floor(sz.length/2)])}, суммарно размещено ${f(g.reduce((s,x)=>s+x.size,0))}`);
}
