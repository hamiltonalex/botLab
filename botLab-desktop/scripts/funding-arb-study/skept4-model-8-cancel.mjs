// А2. Отбор по исходу: сколько заявок НЕ исполнилось, и по какой причине.
import fs from "node:fs";
import { SP, T0, T1, URL_ARB, E30, gql, marketMap } from "./imp-gmx-lib.mjs";
const M=marketMap(); const E=[0,1e3,5e3,20e3,50e3,200e3,Infinity];
const L=["<$1k","$1-5k","$5-20k","$20-50k","$50-200k",">=$200k"];
const e30=u=>u===Infinity?null:BigInt(Math.round(u))*10n**30n;
const names=["OrderExecuted","OrderCancelled","OrderFrozen","OrderUpdated","OrderCreated"];
// какие вообще бывают eventName - через totalCount по каждому кандидату на BTC
const btc=M.get("BTC").addr;
const probe=await gql(URL_ARB,`{ ${names.map((n,i)=>`e${i}: tradeActionsConnection(orderBy: id_ASC, where:{marketAddress_eq:"${btc}", eventName_eq:"${n}", timestamp_gte:${T0}, timestamp_lte:${T1}}){ totalCount }`).join(" ")} }`);
console.log("BTC, событий за год:", names.map((n,i)=>`${n}=${probe['e'+i].totalCount}`).join("  "));

const toks=["BTC","SOL","LINK","DOGE","PENGU","BNB","NEAR","TAO","PENDLE","ARB","AVAX","WIF"];
console.log("\n| рынок | полоса | исполнено | отменено | заморожено | доля неисполненных |");
console.log("|---|---|---|---|---|---|");
const totals={};
for(const t of toks){ const a=M.get(t).addr; const parts=[];
  for(let b=0;b<6;b++) for(const [j,ev] of [["x","OrderExecuted"],["c","OrderCancelled"],["f","OrderFrozen"]]){
    const lo=`, sizeDeltaUsd_gte: "${e30(E[b])}"`, hi=E[b+1]===Infinity?"":`, sizeDeltaUsd_lt: "${e30(E[b+1])}"`;
    parts.push(`${j}${b}: tradeActionsConnection(orderBy: id_ASC, where:{marketAddress_eq:"${a}", eventName_eq:"${ev}", sizeDeltaUsd_gt:"0", timestamp_gte:${T0}, timestamp_lte:${T1}${lo}${hi}}){ totalCount }`);
  }
  const d=await gql(URL_ARB,`{ ${parts.join(" ")} }`);
  for(let b=0;b<6;b++){ const x=d['x'+b].totalCount,c=d['c'+b].totalCount,fz=d['f'+b].totalCount;
    if(x+c+fz===0)continue;
    (totals[b]??=[0,0,0]); totals[b][0]+=x; totals[b][1]+=c; totals[b][2]+=fz;
    console.log(`| ${t} | ${L[b]} | ${x} | ${c} | ${fz} | ${(100*(c+fz)/(x+c+fz)).toFixed(1)}% |`); }
}
console.log("\n| ИТОГО по 12 рынкам | исполнено | отменено | заморожено | доля неисполненных |");
for(let b=0;b<6;b++){ if(!totals[b])continue; const [x,c,fz]=totals[b];
  console.log(`| ${L[b]} | ${x} | ${c} | ${fz} | ${(100*(c+fz)/(x+c+fz)).toFixed(1)}% |`); }
