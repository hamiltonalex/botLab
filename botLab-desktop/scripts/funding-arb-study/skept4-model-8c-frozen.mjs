// Заморозки (заявка не исполнена по цене) - вот где сидит отбор по исходу.
import fs from "node:fs";
import { SP, T0, T1, URL_ARB, E30, gql, marketMap } from "./imp-gmx-lib.mjs";
const M=marketMap(); const c63=JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8"));
const addrs=c63.map(r=>M.get(r.t).addr);
// все заморозки по всем 63 рынкам за год
const rows=[]; const seen=new Set();
const inList=addrs.map(a=>`"${a}"`).join(",");
let cur=T0;
for(let p=0;p<60;p++){
  const d=await gql(URL_ARB,`{ tradeActions(limit:1000, orderBy: timestamp_ASC, where:{marketAddress_in:[${inList}], eventName_eq:"OrderFrozen", sizeDeltaUsd_gt:"0", timestamp_gte:${cur}, timestamp_lte:${T1}}){ id timestamp marketAddress orderType sizeDeltaUsd reason reasonBytes } }`);
  if(!d.tradeActions.length)break;
  for(const r of d.tradeActions) if(!seen.has(r.id)){seen.add(r.id);rows.push(r);}
  if(d.tradeActions.length<1000)break;
  cur=d.tradeActions[d.tradeActions.length-1].timestamp+1;
}
console.log("заморозок по 63 рынкам за год:",rows.length);
const by={}; for(const r of rows){const k=r.reason||"(null)"; (by[k]??=[]).push(Number(r.sizeDeltaUsd)/E30);}
const med=xs=>{const s=xs.slice().sort((x,y)=>x-y);return s[Math.floor(s.length/2)];};
for(const [k,v] of Object.entries(by).sort((a,b)=>b[1].length-a[1].length))
  console.log(`  ${k}: n=${v.length}, мед размер $${Math.round(med(v)).toLocaleString("en-US")}, >=$50k у ${v.filter(x=>x>=5e4).length}`);
// раскладка по размеру против исполненных
const E=[0,1e3,5e3,20e3,50e3,200e3,Infinity], L=["<$1k","$1-5k","$5-20k","$20-50k","$50-200k",">=$200k"];
const bx=s=>{for(let i=E.length-2;i>=0;i--) if(s>=E[i])return i; return 0;};
const fb=E.map(()=>0); for(const r of rows) fb[bx(Number(r.sizeDeltaUsd)/E30)]++;
// исполненные по полосам берём из уже собранного impact-gmx.json (точные счётчики)
const J=JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`,"utf8"));
const xb=E.map(()=>0);
for(const m of Object.values(J.markets)) for(let b=0;b<6;b++){ const c=m.counts||{}; xb[b]+=(c[`b${b}_L`]||0)+(c[`b${b}_S`]||0); }
console.log("\n| полоса | исполнено (точно) | заморожено | доля заморозок |");
for(let b=0;b<6;b++) console.log(`| ${L[b]} | ${xb[b].toLocaleString("en-US")} | ${fb[b]} | ${(100*fb[b]/(xb[b]+fb[b])).toFixed(3)}% |`);
