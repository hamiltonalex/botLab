// Пересборка postClose-кривой на totalImpactUsd = priceImpactUsd + proportionalPendingImpactUsd.
// Это ВЕСЬ impact круга в нынешнем режиме: собственный impact закрытия ПЛЮС отложенный impact входа,
// который прогон 4 выкинул, объявив при этом что берёт "весь impact круга".
import fs from "node:fs"; import path from "node:path";
import { SP, q } from "./imp-gmx-lib.mjs";
const EDGES=[0,1e3,5e3,20e3,50e3,200e3,500e3,1e6,2e6,5e6,Infinity];
const LBL=["<$1k","$1-5k","$5-20k","$20-50k","$50-200k","$200-500k","$500k-1M","$1-2M","$2-5M",">=$5M"];
const bx=s=>{for(let i=EDGES.length-2;i>=0;i--) if(s>=EDGES[i])return i; return 0;};
const DEC=new Set([4,5,6]); const POST=1759276800; const MINN=25;
const RAW=`${SP}/imp-raw`, T=JSON.parse(fs.readFileSync(`${SP}/imp-tail.json`,"utf8"));
const byMarket={}, agg={long:[],short:[]};
for(const f of fs.readdirSync(RAW).filter(x=>x.endsWith(".json"))){
  const d=JSON.parse(fs.readFileSync(path.join(RAW,f),"utf8")), t=d.t;
  const bins={long:EDGES.map(()=>[]),short:EDGES.map(()=>[])};
  const feed=rows=>{for(const [ts,ot,isL,size,pi,ti] of rows){
    if(!(size>0)||ot===7||!DEC.has(ot)||ts<POST||ti==null)continue;
    const r={size,bps:1e4*ti/size}; bins[isL?"long":"short"][bx(size)].push(r); agg[isL?"long":"short"].push(r);}};
  feed(d.sample); if(d.sampleMode!=="full")feed(d.big); feed(T.byMarket[t]??[]);
  const g={};
  for(const side of ["long","short"]){ const det=[];
    for(let b=0;b<10;b++){const a=bins[side][b]; if(a.length<MINN)continue;
      det.push({band:LBL[b],medSizeUsd:q(.5,a.map(r=>r.size)),medBps:q(.5,a.map(r=>r.bps)),
        p25:q(.25,a.map(r=>r.bps)),p75:q(.75,a.map(r=>r.bps)),n:a.length});}
    g[`postClose_${side}`]={bands:det}; }
  byMarket[t]=g;
}
const pooled={};
for(const side of ["long","short"]){ const bins=EDGES.map(()=>[]);
  for(const r of agg[side]) bins[bx(r.size)].push(r);
  const det=[]; for(let b=0;b<10;b++){const a=bins[b]; if(a.length<MINN)continue;
    det.push({band:LBL[b],sizeUsd:q(.5,a.map(r=>r.size)),bps:q(.5,a.map(r=>r.bps)),
      meanBps:a.reduce((s,r)=>s+r.bps,0)/a.length,adverseBps:q(.25,a.map(r=>r.bps)),favourableBps:q(.75,a.map(r=>r.bps)),n:a.length});}
  pooled[side]=det; }
fs.writeFileSync(`${SP}/skept4-gmx-total.json`, JSON.stringify({pooled,byMarket}));
const f2=x=>(x>=0?"+":"")+x.toFixed(2);
for(const side of ["short","long"]){console.log(`postClose_${side} (totalImpactUsd):`);
  for(const b of pooled[side]) console.log("  ",b.band.padEnd(10),"мед",f2(b.bps).padStart(7),"средн",f2(b.meanBps).padStart(7),"p25",f2(b.adverseBps).padStart(7),"n="+b.n);}
const cov=Object.entries(byMarket).filter(([,g])=>["short","long"].some(s=>(g[`postClose_${s}`].bands||[]).length>=3)).length;
console.log("рынков с >=3 полосами хотя бы на одной стороне:",cov,"из",Object.keys(byMarket).length);
