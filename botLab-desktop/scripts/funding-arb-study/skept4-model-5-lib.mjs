import { DATA as STUDY_DATA } from "./paths.mjs";
// Скептическая обвязка. TAB, стакан HL и движок берутся из прогона 4 БЕЗ изменений,
// подменяется ТОЛЬКО кривая GMX: priceImpactUsd -> totalImpactUsd (= priceImpact + отложенный вход).
import fs from "node:fs";
import { TAB, CAP, YRS, hlRtBps, hlCapUsd, DEFAULT_COSTS, roundTripCost, GMXI, pc, med } from "./run4-lib.mjs";
export { TAB, CAP, YRS, hlCapUsd, pc, med, hlRtBps };
const SP=STUDY_DATA;
const TOT=JSON.parse(fs.readFileSync(`${SP}/skept4-gmx-total.json`,"utf8"));

function interpLog(nodes,S){ if(!nodes||!nodes.length)return NaN;
  const L=Math.log10(Math.max(S,1)); if(L<=Math.log10(nodes[0].x))return nodes[0].y;
  for(let i=1;i<nodes.length;i++){const a=nodes[i-1],b=nodes[i],la=Math.log10(a.x),lb=Math.log10(b.x);
    if(L<=lb)return lb>la?a.y+(b.y-a.y)*(L-la)/(lb-la):b.y;}
  return nodes[nodes.length-1].y; }

// --- кривая прогона 4 (priceImpactUsd) ---
const P_pool={short:GMXI.curveForModel.short_roundTripCurrentRegime.map(b=>({x:b.sizeUsd,y:b.bps})),
              long: GMXI.curveForModel.long_roundTripCurrentRegime.map(b=>({x:b.sizeUsd,y:b.bps}))};
const P_adv={short:GMXI.curveForModel.short_roundTripCurrentRegime.map(b=>({x:b.sizeUsd,y:b.adverseBps})),
             long: GMXI.curveForModel.long_roundTripCurrentRegime.map(b=>({x:b.sizeUsd,y:b.adverseBps}))};
const P_mkt=new Map();
for(const [t,g] of Object.entries(GMXI.growth.byMarket||{})) for(const side of ["short","long"]){
  const nds=(g[`postClose_${side}`]?.bands||[]).filter(b=>b.n>=25&&Number.isFinite(b.medBps)).map(b=>({x:b.medSizeUsd,y:b.medBps}));
  if(nds.length>=3)P_mkt.set(`${t}|${side}`,nds); }
// --- кривая скептика (totalImpactUsd) ---
const T_pool={short:TOT.pooled.short.map(b=>({x:b.sizeUsd,y:b.bps})), long:TOT.pooled.long.map(b=>({x:b.sizeUsd,y:b.bps}))};
const T_adv ={short:TOT.pooled.short.map(b=>({x:b.sizeUsd,y:b.adverseBps})), long:TOT.pooled.long.map(b=>({x:b.sizeUsd,y:b.adverseBps}))};
const T_mkt=new Map();
for(const [t,g] of Object.entries(TOT.byMarket||{})) for(const side of ["short","long"]){
  const nds=(g[`postClose_${side}`]?.bands||[]).filter(b=>b.n>=25&&Number.isFinite(b.medBps)).map(b=>({x:b.medSizeUsd,y:b.medBps}));
  if(nds.length>=3)T_mkt.set(`${t}|${side}`,nds); }
export const covered={price:P_mkt.size,total:T_mkt.size};

// какой узел кривой реально применяется и сколько за ним наблюдений
const bandInfo=new Map();
for(const [t,g] of Object.entries(TOT.byMarket||{})) for(const side of ["short","long"])
  bandInfo.set(`${t}|${side}`,(g[`postClose_${side}`]?.bands||[]));
export function topNode(t,cfg,which="total"){ const side=cfg==="A"?"short":"long";
  const m=(which==="total"?T_mkt:P_mkt).get(`${t}|${side}`); return m?m[m.length-1]:null; }
export function bandsOf(t,cfg){ return bandInfo.get(`${t}|${cfg==="A"?"short":"long"}`)||[]; }

export function gmxBps(t,cfg,S,{which="total",adverse=false}={}){
  const side=cfg==="A"?"short":"long";
  const mkt=which==="total"?T_mkt:P_mkt, pool=which==="total"?T_pool:P_pool, adv=which==="total"?T_adv:P_adv;
  if(!adverse){const n=mkt.get(`${t}|${side}`); if(n)return interpLog(n,S);}
  return interpLog(adverse?adv[side]:pool[side],S);
}
const NOIMP={...DEFAULT_COSTS,gmxImpact:0};
export function makeCost(which){ return (t,cfg,S,o)=>{
  const base=roundTripCost(NOIMP,S,false);
  const gb=which==="flat"?-10:gmxBps(t,cfg,S,{which,adverse:o.gmxAdverse});
  const gmxImpactUsd=-(gb/1e4)*S;
  const hlSlipUsd=(hlRtBps(t,o.hlVariant,S)/1e4)*S;
  return {total:base+gmxImpactUsd+hlSlipUsd,base,gmxImpactUsd,hlSlipUsd,gmxBps:gb}; }; }
