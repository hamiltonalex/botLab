import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP=STUDY_DATA;
const J=JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`,"utf8"));
const XS=J.meta.xs, T=J.tokens;
const med=(a)=>{const s=a.filter(Number.isFinite).sort((x,y)=>x-y);return s.length?(s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2):NaN;};
const f=(v)=>v==null?"  OVER":v.toFixed(1).padStart(6);
const names=Object.keys(T).sort((a,b)=>T[b].raw.buy.visibleNtl-T[a].raw.buy.visibleNtl);

console.log("=== СЫРЫЕ КРИВЫЕ (стакан 2026-08-30), бп от середины, покупка/продажа ===");
console.log("token      spr   "+XS.map(x=>("$"+(x/1000)+"k").padStart(13)).join(""));
for(const t of names){
  const d=T[t];
  const b=d.raw.buy.bps.map(f), s=d.raw.sell.bps.map(f);
  console.log(t.padEnd(10),d.spreadBps.toFixed(1).padStart(5),
    b.map((x,i)=>(x+"/"+s[i]).padStart(14)).join(""));
}
console.log();
console.log("=== КОНЕЦ СТАКАНА: весь видимый резервный объём (жёсткий потолок разовой заявки) ===");
console.log("token       видно_купить$   видно_продать$   X_переполнения(buy)  X_переполнения(sell)   объём$/сут(сегодня)");
for(const t of names){
  const d=T[t];
  console.log(t.padEnd(11),Math.round(d.raw.buy.visibleNtl).toLocaleString("en").padStart(14),
    Math.round(d.raw.sell.visibleNtl).toLocaleString("en").padStart(16),
    String(d.raw.buy.exhaustedFrom?"$"+(d.raw.buy.exhaustedFrom/1000)+"k":"-").padStart(20),
    String(d.raw.sell.exhaustedFrom?"$"+(d.raw.sell.exhaustedFrom/1000)+"k":"-").padStart(21),
    Math.round(d.volume.todayNtl).toLocaleString("en").padStart(20));
}
console.log();
console.log("=== АСИММЕТРИЯ: продажа минус покупка, бп (плюс = продавать дороже) ===");
console.log("token      "+XS.map(x=>("$"+(x/1000)+"k").padStart(9)).join(""));
for(const t of names){
  const d=T[t];
  console.log(t.padEnd(10),XS.map((_,i)=>{
    const a=d.raw.buy.bps[i], s=d.raw.sell.bps[i];
    return (a==null||s==null?"n/a":(s-a).toFixed(1)).padStart(9);}).join(""));
}
