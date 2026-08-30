import { run } from "./skept4-model-5-grid.mjs";
import { hlRtBps } from "./skept4-model-5-lib.mjs";
import { DEFAULT_COSTS, roundTripCost } from "./run4-lib.mjs";
const f=x=>"$"+Math.round(x).toLocaleString("en-US");
const NOIMP={...DEFAULT_COSTS,gmxImpact:0};
const mk=bps=>(t,cfg,S,o)=>{const base=roundTripCost(NOIMP,S,false);
  const g=-(bps/1e4)*S,h=(hlRtBps(t,o.hlVariant,S)/1e4)*S;
  return {total:base+g+h,base,gmxImpactUsd:g,hlSlipUsd:h,gmxBps:bps};};
const snap={};
for(const b of [-50,-60]){const d=[];run({capital:1000000,cf:mk(b),dump:d});snap[b]=d;}
const key=p=>p.per+"|"+p.t+"/"+p.cfg;
const A=new Map(snap[-50].map(p=>[key(p),p])), B=new Map(snap[-60].map(p=>[key(p),p]));
console.log("появились при -60:");
for(const [k,p] of B) if(!A.has(k)) console.log(`  ${k} размер ${f(p.size)}, брутто ${f(p.g1*p.size)}, реализ. ставка ${(100*p.g1*8760/720).toFixed(0)}% годовых`);
console.log("исчезли при -60:");
let lost=0,ln=0; for(const [k,p] of A) if(!B.has(k)){lost+=p.g1*p.size;ln++;}
console.log(`  ${ln} позиций, суммарно брутто ${f(lost)}`);
