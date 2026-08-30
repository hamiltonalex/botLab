// Почему заявки не исполнялись: причина отмены и размер.
import { T0, T1, URL_ARB, E30, gql, marketMap } from "./imp-gmx-lib.mjs";
const M=marketMap();
const toks=["BTC","SOL","LINK","DOGE","PENGU","BNB","NEAR","TAO","PENDLE","ARB"];
const agg={};
for(const t of toks){ const a=M.get(t).addr; const rows=[];
  let cur=T0; const seen=new Set();
  for(let p=0;p<6;p++){
    const d=await gql(URL_ARB,`{ tradeActions(limit:1000, orderBy: timestamp_ASC, where:{marketAddress_eq:"${a}", eventName_eq:"OrderCancelled", sizeDeltaUsd_gt:"0", timestamp_gte:${cur}, timestamp_lte:${T1}}){ id timestamp orderType sizeDeltaUsd reason } }`);
    if(!d.tradeActions.length)break;
    for(const r of d.tradeActions) if(!seen.has(r.id)){seen.add(r.id);rows.push(r);}
    if(d.tradeActions.length<1000)break;
    cur=d.tradeActions[d.tradeActions.length-1].timestamp+1;
  }
  for(const r of rows){ const k=r.reason||"(null)"; (agg[k]??={n:0,sz:[]}); agg[k].n++; agg[k].sz.push(Number(r.sizeDeltaUsd)/E30); }
  console.log(t,"выборка отмен:",rows.length);
}
const med=xs=>{const s=xs.slice().sort((x,y)=>x-y);return s[Math.floor(s.length/2)];};
const tot=Object.values(agg).reduce((s,v)=>s+v.n,0);
console.log("\n| причина отмены | n | доля | медианный размер | доля >=$50k |");
for(const [k,v] of Object.entries(agg).sort((a,b)=>b[1].n-a[1].n).slice(0,15))
  console.log(`| ${k} | ${v.n} | ${(100*v.n/tot).toFixed(1)}% | $${Math.round(med(v.sz)).toLocaleString("en-US")} | ${(100*v.sz.filter(x=>x>=5e4).length/v.n).toFixed(1)}% |`);
