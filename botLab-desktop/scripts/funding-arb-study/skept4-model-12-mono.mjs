// Монотонна ли модель по издержке: больше платим - меньше зарабатываем?
import { run } from "./skept4-model-5-grid.mjs";
import { gmxBps, hlRtBps } from "./skept4-model-5-lib.mjs";
import { DEFAULT_COSTS, roundTripCost } from "./run4-lib.mjs";
const f=x=>(x<0?"-$":"$")+Math.round(Math.abs(x)).toLocaleString("en-US");
const NOIMP={...DEFAULT_COSTS,gmxImpact:0};
const mk=bps=>(t,cfg,S,o)=>{const base=roundTripCost(NOIMP,S,false);
  const g=-(bps/1e4)*S, h=(hlRtBps(t,o.hlVariant,S)/1e4)*S;
  return {total:base+g+h,base,gmxImpactUsd:g,hlSlipUsd:h,gmxBps:bps};};
console.log("| постоянный impact GMX, бп | $/год | брутто | издержки | смен размера | имён |");
for(const bps of [0,-2,-5,-10,-20,-50,-100]){ const r=run({capital:1000000,cf:mk(bps)});
  console.log(`| ${bps} | ${f(r.usd)} | ${f(r.grossUsd)} | ${f(r.costUsd)} | ${r.changes} | ${r.names} |`); }
