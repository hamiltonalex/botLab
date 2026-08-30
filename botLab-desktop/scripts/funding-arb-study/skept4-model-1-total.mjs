// А1. postClose-кривая на priceImpactUsd против totalImpactUsd, НА ОДНОМ И ТОМ ЖЕ ПОДМНОЖЕСТВЕ.
import fs from "node:fs"; import path from "node:path";
import { SP, q } from "./imp-gmx-lib.mjs";
const EDGES=[0,1e3,5e3,20e3,50e3,200e3,500e3,1e6,2e6,5e6,Infinity];
const LBL=["<$1k","$1-5k","$5-20k","$20-50k","$50-200k","$200-500k","$500k-1M","$1-2M","$2-5M",">=$5M"];
const bx=s=>{for(let i=EDGES.length-2;i>=0;i--) if(s>=EDGES[i])return i; return 0;};
const DEC=new Set([4,5,6]); const POST=1759276800;
const RAW=`${SP}/imp-raw`, T=JSON.parse(fs.readFileSync(`${SP}/imp-tail.json`,"utf8"));
// доля null по месяцам в postClose
const mon={};
const agg={long:[],short:[]};
for(const f of fs.readdirSync(RAW).filter(x=>x.endsWith(".json"))){
  const d=JSON.parse(fs.readFileSync(path.join(RAW,f),"utf8")), t=d.t;
  const feed=rows=>{for(const [ts,ot,isL,size,pi,ti] of rows){
    if(!(size>0)||ot===7||!DEC.has(ot)||ts<POST) continue;
    const m=new Date(ts*1000).toISOString().slice(0,7); (mon[m]??=[0,0]); mon[m][0]++; if(ti==null)mon[m][1]++;
    agg[isL?"long":"short"].push({size,p:1e4*pi/size,tt:ti==null?null:1e4*ti/size});}};
  feed(d.sample); if(d.sampleMode!=="full")feed(d.big); feed(T.byMarket[t]??[]);
}
console.log("доля null у totalImpactUsd по месяцам (только закрытия с окт-2025):");
for(const m of Object.keys(mon).sort()) console.log(" ",m,"n="+mon[m][0], "null "+(100*mon[m][1]/mon[m][0]).toFixed(1)+"%");
const f2=x=>x==null?"   -  ":(x>=0?"+":"")+x.toFixed(2);
for(const side of ["short","long"]){
  console.log(`\n=== postClose_${side}: priceImpactUsd (в прогоне) против totalImpactUsd ===`);
  console.log("| полоса | n всего | n с total | мед price (все) | мед price (подмн.) | мед TOTAL (подмн.) | сдвиг |");
  const bins=EDGES.map(()=>[]); for(const r of agg[side]) bins[bx(r.size)].push(r);
  for(let b=0;b<10;b++){const a=bins[b]; if(a.length<25)continue;
    const sub=a.filter(r=>r.tt!=null);
    const mAll=q(.5,a.map(r=>r.p)), mSubP=sub.length>=25?q(.5,sub.map(r=>r.p)):null, mSubT=sub.length>=25?q(.5,sub.map(r=>r.tt)):null;
    console.log(`| ${LBL[b].padEnd(9)} | ${String(a.length).padStart(6)} | ${String(sub.length).padStart(6)} | ${f2(mAll)} | ${f2(mSubP)} | ${f2(mSubT)} | ${mSubT!=null?f2(mSubT-mSubP):"-"} |`);
  }
}
