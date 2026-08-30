import fs from "node:fs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30=1e30, CEIL=1e-7;
const T=["FET","MOODENG","BOME","ORDI","BERA","WIF"];
function q(a,p){const s=[...a].sort((x,y)=>x-y);return s[Math.floor(p*(s.length-1))];}
console.log("Проверка сохранения фандинга:  (ставка получателя x OI получателя) / (ставка плательщика x OI плательщика)");
console.log("токен   часов   p10     медиана    p90     |  то же ТОЛЬКО в аномальные часы: медиана");
for(const t of T){
  const oi=new Map(JSON.parse(fs.readFileSync(`truth-b-raw/oi_${t}.json`,"utf8"))
    .map(r=>[Math.floor(r.snapshotTimestamp/3600)*3600,{L:Number(r.longOpenInterestUsd)/E30,S:Number(r.shortOpenInterestUsd)/E30}]));
  const all=[],an=[];
  for(const r of cacheRows(t)){
    const h=Math.floor(Date.parse(r.ts.replace(" ","T"))/1000/3600)*3600;
    const o=oi.get(h); if(!o) continue;
    const fl=+r.f_long, fs2=+r.f_short; if(fl===0||fs2===0) continue;
    const recvIsLong=fl>0;
    const recvOi=recvIsLong?o.L:o.S, payOi=recvIsLong?o.S:o.L;
    const recvR=Math.abs(recvIsLong?fl:fs2), payR=Math.abs(recvIsLong?fs2:fl);
    const den=payR*payOi; if(!(den>0)) continue;
    const ratio=(recvR*recvOi)/den; if(!isFinite(ratio)) continue;
    all.push(ratio);
    if(Math.max(Math.abs(fl),Math.abs(fs2))>CEIL) an.push(ratio);
  }
  console.log(t.padEnd(8),String(all.length).padStart(5),q(all,.1).toFixed(3).padStart(7),q(all,.5).toFixed(3).padStart(9),q(all,.9).toFixed(3).padStart(8),
    "  |",String(an.length).padStart(5),"часов, медиана",(an.length?q(an,.5).toFixed(3):"-").padStart(7));
}
