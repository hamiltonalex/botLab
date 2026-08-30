import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP=STUDY_DATA;
const cap=JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8"));
const OCT=Date.UTC(2025,9,1)/1000, SEP=Date.UTC(2025,8,1)/1000;
let tot=0, nn=0, nullPre=0, nullPost=0, postN=0, preN=0;
const INC=new Set([2,3,8]), DEC=new Set([4,5,6]);
let same=0,diff=0; const dd=[];
for(const r of cap){
  const j=JSON.parse(fs.readFileSync(`${SP}/imp-raw/${r.t}.json`,"utf8"));
  for(const src of [j.sample,j.big]) for(const row of src){
    const [ts,ot,isL,sz,pi,ti]=row; if(ot===7||!(sz>0))continue;
    tot++; if(ti==null){ if(ts<SEP)nullPre++; else nullPost++; } else nn++;
    if(ts>=OCT){postN++; if(ti!=null){ if(Math.abs(ti-pi)<1e-9)same++; else {diff++; if(dd.length<200000)dd.push(1e4*(ti-pi)/sz);} }} else if(ts<SEP) preN++;
  }
}
console.log("всего строк:",tot,"| с totalImpactUsd:",nn,"| null до сент:",nullPre,"| null с сент:",nullPost);
console.log("строк с окт-2025:",postN,"| total==price:",same,"| отличается:",diff);
const s=dd.sort((a,b)=>a-b); const Q=p=>s[Math.floor((s.length-1)*p)];
console.log("разница (total-price) bps, где отличается: p5",Q(.05)?.toFixed(2),"p25",Q(.25)?.toFixed(2),"med",Q(.5)?.toFixed(2),"p75",Q(.75)?.toFixed(2),"p95",Q(.95)?.toFixed(2));
