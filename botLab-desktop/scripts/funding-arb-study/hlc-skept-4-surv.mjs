import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const [meta,ctxs]=await L.hlInfo({type:"metaAndAssetCtxs"});
const uni=meta.universe;
const live=uni.filter(u=>!u.isDelisted).map(u=>u.name);
const dead=uni.filter(u=>u.isDelisted).map(u=>u.name);
console.log(`Вселенная HL сегодня: ${uni.length} тикеров, живых ${live.length}, делистнутых ${dead.length}`);
const cache=new Set(L.all.keys());
console.log(`В кэше ${cache.size}. Живых HL, которых НЕТ в кэше: ${live.filter(n=>!cache.has(n)).length}`);
console.log(`Из кэша нет в живом списке HL: ${[...cache].filter(n=>!live.includes(n)).join(", ")||"нет"}`);
// торговались ли делистнутые в окне замера?
const st=L.all.get("BTC")[0].tsHour*1000, en=L.all.get("BTC").at(-1).tsHour*1000;
const hit=[]; let checked=0;
for(const n of dead){
  checked++;
  let h; try{ h=await L.hlInfo({type:"fundingHistory",coin:n,startTime:st+180*86400000,endTime:st+180*86400000+20*3600000}); }catch(e){ continue; }
  if(h&&h.length){ const r=h.map(x=>Number(x.fundingRate)); hit.push({n,n_h:h.length,apr:r.reduce((a,b)=>a+b,0)/r.length*8760}); }
}
console.log(`\nДелистнутых проверено ${checked}; ТОРГОВАЛИСЬ в середине окна замера (2025-12-17): ${hit.length}`);
hit.sort((a,b)=>a.apr-b.apr);
console.log(hit.map(h=>`${h.n} ${L.pc(h.apr,1)}`).join("  "));
if(hit.length){
  const aprs=hit.map(h=>h.apr);
  console.log(`Их шорт-керри (20-часовая проба): медиана ${L.pc(L.q(aprs,0.5))}, среднее ${L.pc(L.mean(aprs))}, отрицательных ${aprs.filter(a=>a<0).length}/${aprs.length}`);
}
fs.writeFileSync("hlc-skept-surv.json",JSON.stringify({live:live.length,dead:dead.length,hit}));
