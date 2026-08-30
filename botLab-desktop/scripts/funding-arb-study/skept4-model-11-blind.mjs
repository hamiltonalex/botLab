// Сколько вообще весит МОДЕЛЬ ИЗДЕРЖЕК в ответе. Гоняем один и тот же тракт с разной издержкой.
import { run } from "./skept4-model-5-grid.mjs";
import { gmxBps, hlRtBps, TAB } from "./skept4-model-5-lib.mjs";
import { DEFAULT_COSTS, roundTripCost } from "./run4-lib.mjs";
const f=x=>(x<0?"-$":"$")+Math.round(Math.abs(x)).toLocaleString("en-US");
const NOIMP={...DEFAULT_COSTS,gmxImpact:0};
const mk=(gmxMode,slipMult)=>(t,cfg,S,o)=>{
  const base=roundTripCost(NOIMP,S,false);
  const gb=gmxMode==="none"?0:gmxMode==="flat"?-10:gmxBps(t,cfg,S,{which:gmxMode,adverse:o.gmxAdverse});
  const gmxImpactUsd=-(gb/1e4)*S;
  const hlSlipUsd=slipMult*(hlRtBps(t,o.hlVariant,S)/1e4)*S;
  return {total:base+gmxImpactUsd+hlSlipUsd,base,gmxImpactUsd,hlSlipUsd,gmxBps:gb};};
const zero=()=>({total:0,base:0,gmxImpactUsd:0,hlSlipUsd:0,gmxBps:0});
const cases=[
  ["издержек НЕТ вообще",zero],
  ["только движок (gmxImpact=0, без слиппеджа)",mk("none",0)],
  ["движок + плоские -10 бп (прогон 3)",mk("flat",0)],
  ["прогон 4: price + слиппедж HL",mk("price",1)],
  ["СКЕПТИК: total + слиппедж HL",mk("total",1)],
  ["скептик, слиппедж HL x3",mk("total",3)],
  ["скептик, слиппедж HL x10",mk("total",10)],
];
console.log("| модель издержек | $1M капитала | $/год плато | издержки $/год | доля издержек в брутто |");
console.log("|---|---|---|---|---|");
for(const [lbl,cf] of cases){ const r=run({capital:1000000,cf});
  console.log(`| ${lbl} | | ${f(r.usd)} | ${f(r.costUsd)} | ${(100*r.costUsd/r.grossUsd).toFixed(1)}% |`);}
console.log("\nтот же ряд на жёстком угле (10% своб. ликв. GMX, сырой стакан, пик<=5, $10M):");
for(const [lbl,cf] of cases){ const r=run({capital:1e7,margin:10,hlVariant:"raw",sane:5,gmxAdverse:true,cf});
  console.log(`  ${lbl}: ${f(r.usd)}`);}
