import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP=STUDY_DATA;
const API="https://api.hyperliquid.xyz/info";
const cap=JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8"));
const bks=JSON.parse(fs.readFileSync(`${SP}/imp-hl-books.json`,"utf8"));
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const post=async(b)=>{for(let k=0;k<5;k++){try{const r=await fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(r.status===429){await sleep(1200*(k+1));continue;}return await r.json();}catch(e){await sleep(500*(k+1));}}};
const out={};
for(const row of cap){
  const coin=bks[row.t].coin;
  // ctx и стакан подряд, без задержки: пара для сверки impactPxs
  const [ctxAll,b5,bnull]=await Promise.all([post({type:"metaAndAssetCtxs"}),post({type:"l2Book",coin,nSigFigs:5}),post({type:"l2Book",coin})]);
  const [meta,ctxs]=ctxAll; const i=meta.universe.findIndex(u=>u.name===coin);
  if(i<0||!bnull?.levels?.[0]?.length||!bnull?.levels?.[1]?.length) continue;
  out[row.t]={coin,ctx:ctxs[i],lev:meta.universe[i].maxLeverage,
    bids:bnull.levels[0].map(l=>[+l.px,+l.sz]),asks:bnull.levels[1].map(l=>[+l.px,+l.sz]),
    bids5:b5.levels[0].map(l=>[+l.px,+l.sz]),asks5:b5.levels[1].map(l=>[+l.px,+l.sz])};
  await sleep(60);
}
fs.writeFileSync(`${SP}/imp-hl-paired.json`,JSON.stringify(out));
console.log("парных снимков:",Object.keys(out).length);
