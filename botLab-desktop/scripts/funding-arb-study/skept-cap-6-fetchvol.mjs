import { CACHE as STUDY_CACHE } from "./paths.mjs";
// Ёмкость снята 2026-08-30, а прогон идёт 2025-06..2026-06. Узкая нога у критика это «1% суточного
// оборота HL», причём оборот взят ОДНИМ ДНЁМ (dayNtlVlm). Качаем РЕАЛЬНЫЙ дневной оборот HL за сам
// период прогона: свечи 1d, оборот = v(в монетах) * c(цена закрытия).
import fs from "node:fs";
import { capRows, SP } from "./skept-cap-lib.mjs";
const lines=fs.readFileSync(STUDY_CACHE+"/_scan_results.csv","utf8").trim().split("\n");
const ix=Object.fromEntries(lines[0].split(",").map((h,i)=>[h,i]));
const COIN=new Map(lines.slice(1).map(l=>{const p=l.split(",");return [p[ix.token],p[ix.hl_coin]];}));
const S=1750402800000, E=1781938800000;
const out={};
for (const r of capRows) {
  const coin=COIN.get(r.t)||r.t;
  const res=await fetch("https://api.hyperliquid.xyz/info",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({type:"candleSnapshot",req:{coin,interval:"1d",startTime:S,endTime:E}})});
  const j=await res.json();
  if(!Array.isArray(j)||!j.length){console.error("нет свечей",r.t,coin);out[r.t]=null;continue;}
  out[r.t]=j.map(c=>({t:c.t, ntl: Number(c.v)*Number(c.c)}));
  await new Promise(r=>setTimeout(r,120));
}
fs.writeFileSync(`${SP}/skept-hlvol.json`, JSON.stringify(out));
const med=(xs)=>{const a=xs.slice().sort((x,y)=>x-y);return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;};
console.log("| токен | дней | оборот-снимок 2026-08-30 $ | медиана за период $ | 10й проц $ | снимок/медиана |");
for (const r of capRows) {
  const c=out[r.t]; if(!c){console.log(`| ${r.t} | нет данных |`);continue;}
  const v=c.map(x=>x.ntl).filter(Number.isFinite).sort((a,b)=>a-b);
  const m=med(v), p10=v[Math.floor(0.1*v.length)];
  console.log(`| ${r.t} | ${v.length} | ${r.hlVol.toFixed(0)} | ${m.toFixed(0)} | ${p10.toFixed(0)} | ${(r.hlVol/m).toFixed(2)}x |`);
}
