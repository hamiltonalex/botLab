import fs from "node:fs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30=1e30, YR=3600*8760;
const TOKS=JSON.parse(fs.readFileSync("cap63.json","utf8")).map(x=>x.t);
const bySign=[], byMag=[]; let anom=0, anomPayerSign=0, anomPayerMag=0, tot=0;
for(const t of TOKS){
  const rows=cacheRows(t); if(!rows) continue;
  for(const r of rows){
    const fl=+r.f_long, fs=+r.f_short; if(!(fl!==0&&fs!==0)) continue; tot++;
    const payS = fl<0?Math.abs(fl):Math.abs(fs);          // по знаку
    const payM = Math.min(Math.abs(fl),Math.abs(fs));     // по магнитуде (как считали раньше)
    bySign.push(payS); byMag.push(payM);
    if(Math.max(Math.abs(fl),Math.abs(fs))>1e-7){ anom++;
      if(payS>1e-7) anomPayerSign++;
      if(payM>1e-7) anomPayerMag++; }
  }
}
const q=(a,p)=>{a.sort((x,y)=>x-y);return a[Math.floor(p*(a.length-1))];};
const S=[...bySign], M=[...byMag];
console.log("СТАВКА ПЛАТЕЛЬЩИКА, % годовых, 63 рынка, часов:", tot.toLocaleString("ru-RU"));
console.log("| квантиль | по ЗНАКУ (верно) | по МАГНИТУДЕ (как считали части 1-3) |");
console.log("|---|---|---|");
for(const p of [.5,.9,.99,.999,.99999,1])
  console.log(`| p${(100*p).toString().replace(/\.?0+$/,"")||"100"} | ${(q(S,p)*YR*100).toFixed(2)}% | ${(q(M,p)*YR*100).toFixed(2)}% |`);
console.log(`\nАномальных часов (>1e-7 хотя бы у одной стороны): ${anom.toLocaleString("ru-RU")}`);
console.log(`  из них плательщик выше 1e-7 ПО ЗНАКУ: ${anomPayerSign.toLocaleString("ru-RU")} (${(100*anomPayerSign/anom).toFixed(2)}%)`);
console.log(`  из них плательщик выше 1e-7 ПО МАГНИТУДЕ: ${anomPayerMag.toLocaleString("ru-RU")} (${(100*anomPayerMag/anom).toFixed(2)}%)`);
