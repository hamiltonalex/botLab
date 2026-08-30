import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP=STUDY_DATA;
const CSV=STUDY_CACHE+"/_scan_results.csv";
const API="https://api.hyperliquid.xyz/info";

// мэппинг token -> hl_coin из _scan_results.csv (последняя колонка)
const lines=fs.readFileSync(CSV,"utf8").trim().split("\n");
const hdr=lines[0].split(",");
const iTok=hdr.indexOf("token"), iCoin=hdr.indexOf("hl_coin");
const map=new Map();
for(const l of lines.slice(1)){const c=l.split(",");map.set(c[iTok],c[iCoin]);}
const cap=JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8"));

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function post(b,tries=5){
  for(let k=0;k<tries;k++){
    try{
      const r=await fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});
      if(r.status===429){await sleep(1500*(k+1));continue;}
      if(!r.ok)throw new Error(r.status+" "+(await r.text()).slice(0,120));
      return await r.json();
    }catch(e){ if(k===tries-1)throw e; await sleep(600*(k+1)); }
  }
}
const SIGS=[null,5,4,3,2];
const out={};
let n=0;
for(const row of cap){
  const coin = map.get(row.t) || row.coin || row.t;
  const books={};
  for(const s of SIGS){
    const req = s===null?{type:"l2Book",coin}:{type:"l2Book",coin,nSigFigs:s};
    const b=await post(req);
    if(!b||!b.levels){books[String(s)]=null;continue;}
    books[String(s)]={time:b.time,
      bids:b.levels[0].map(l=>[+l.px,+l.sz]),
      asks:b.levels[1].map(l=>[+l.px,+l.sz])};
    await sleep(70);
  }
  out[row.t]={coin,books};
  n++;
  if(n%10===0)console.error("fetched",n,"/",cap.length);
}
fs.writeFileSync(`${SP}/imp-hl-books.json`,JSON.stringify(out));
console.log("saved books for",Object.keys(out).length,"tokens at",new Date().toISOString());
