import {q,MAP,SP} from "./truth-v-lib.mjs"; import fs from "node:fs";
// Часть 2: потолок протокола из marketInfos
const toks=[...MAP.keys()];
const addrs=toks.map(t=>MAP.get(t).market);
const out=[];
for(let i=0;i<addrs.length;i+=20){
  const chunk=addrs.slice(i,i+20);
  const d=await q(`{ marketInfos(limit:25, where:{marketTokenAddress_in:[${chunk.map(a=>`"${a}"`).join(",")}]}) {
     marketTokenAddress maxFundingFactorPerSecondLong maxFundingFactorPerSecondShort
     minFundingFactorPerSecondLong minFundingFactorPerSecondShort
     fundingIncreaseFactorPerSecond fundingDecreaseFactorPerSecond fundingFactor fundingExponentFactor
     thresholdForStableFunding thresholdForDecreaseFunding
     fundingFactorPerSecond savedFundingFactorPerSecond fundingUpdatedAt longsPayShorts
     longOpenInterestUsd shortOpenInterestUsd isDisabled } }`);
  out.push(...d.marketInfos);
}
const byAddr=new Map(out.map(m=>[m.marketTokenAddress.toLowerCase(),m]));
const rows=[];
for(const t of toks){ const m=byAddr.get(MAP.get(t).market.toLowerCase()); if(m) rows.push({t,...m}); }
fs.writeFileSync(`${SP}/truth-v-cap.json`,JSON.stringify(rows,null,1));
const S=1e30;
const uniq=new Map();
for(const r of rows){ const k=r.maxFundingFactorPerSecondLong+"/"+r.maxFundingFactorPerSecondShort; uniq.set(k,(uniq.get(k)||0)+1); }
console.log("рынков получено:",rows.length,"из",toks.length);
console.log("\nразные значения maxFundingFactorPerSecond (long/short) и сколько рынков:");
for(const [k,n] of [...uniq].sort((a,b)=>b[1]-a[1])){
  const [L,Sh]=k.split("/").map(x=>Number(x)/S);
  console.log(`  ${n.toString().padStart(3)} рынков  max_long=${L.toExponential(4)} (${(L*3600*8760*100).toFixed(0)}% год)  max_short=${Sh.toExponential(4)} (${(Sh*3600*8760*100).toFixed(0)}% год)`);
}
const mins=new Map();
for(const r of rows){ const k=r.minFundingFactorPerSecondLong+"/"+r.minFundingFactorPerSecondShort; mins.set(k,(mins.get(k)||0)+1); }
console.log("\nразные minFundingFactorPerSecond:");
for(const [k,n] of [...mins].sort((a,b)=>b[1]-a[1]).slice(0,6)){
  const [L,Sh]=k.split("/").map(x=>Number(x)/S);
  console.log(`  ${n} рынков  min_long=${L.toExponential(4)} min_short=${Sh.toExponential(4)}`);
}
console.log("\nпримеры по 5 токенам:");
for(const r of rows.slice(0,5)) console.log(` ${r.t}: maxL=${(Number(r.maxFundingFactorPerSecondLong)/S).toExponential(4)} incr=${(Number(r.fundingIncreaseFactorPerSecond)/S).toExponential(3)} decr=${(Number(r.fundingDecreaseFactorPerSecond)/S).toExponential(3)} fundingFactor=${(Number(r.fundingFactor)/S).toExponential(3)}`);
