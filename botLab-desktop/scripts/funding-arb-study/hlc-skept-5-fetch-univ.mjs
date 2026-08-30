import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const [meta]=await L.hlInfo({type:"metaAndAssetCtxs"});
const uni=meta.universe;
const cache=new Set(L.all.keys());
const btc=L.all.get("BTC"); const st=btc[0].tsHour*1000;
// 4 окна по 500 часов, равномерно по году
const wins=[0,2000,4200,6400].map(h=>st+h*3600000);
const res={};
for(const u of uni){
  const n=u.name; const acc=[];
  for(const w of wins){
    let h; try{ h=await L.hlInfo({type:"fundingHistory",coin:n,startTime:w,endTime:w+500*3600000}); }catch(e){ continue; }
    if(h&&h.length) acc.push(...h.map(x=>[Math.floor(x.time/3600000),Number(x.fundingRate),Number(x.premium)]));
  }
  res[n]={delisted:!!u.isDelisted,inCache:cache.has(n),rows:acc};
  process.stdout.write(".");
}
fs.writeFileSync("hlc-skept-univ.json",JSON.stringify(res));
console.log("\nготово", Object.keys(res).length);
