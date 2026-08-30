import fs from "node:fs";
import { loadCache, pairs } from "./truth-skept-4-calib2.mjs";
const E30=1e30;
function split(cm,a,b,isLong,rule){
  let payS=0,recS=0,noD=0;
  for(let h=Math.floor(a/3600)*3600;h<b;h+=3600){
    const lo=Math.max(a,h),hi=Math.min(b,h+3600),d=hi-lo; if(d<=0) continue;
    const v=cm.get(h); if(!v){noD+=d;continue;}
    const mine=isLong?v.fl:v.fs, other=isLong?v.fs:v.fl;
    const iPay = rule==="sign" ? (mine<0) : (Math.abs(mine)<=Math.abs(other));
    if(iPay) payS+=Math.abs(mine)*d; else recS+=Math.abs(mine)*d;
  }
  return {payS,recS,noD};
}
function calib(tok,file,rule){
  const cm=loadCache(tok); const ps=pairs(file);
  let F=0,pred=0,n=0;
  for(const x of ps){ const s=split(cm,x.a,x.b,x.isLong,rule); if(s.noD>0) continue;
    F+=x.fund; pred+=x.held*s.payS; n++; }
  return {n,F,pred};
}
console.log("КТО ПЛАТЕЛЬЩИК: сравнение двух правил на РЕАЛЬНЫХ списаниях fundingFeeAmount");
console.log("правило «знак»: платит сторона с ОТРИЦАТЕЛЬНОЙ ставкой в кэше");
console.log("правило «магнитуда»: платит сторона с МЕНЬШЕЙ |ставкой| (= с большей базой; это тождество)\n");
console.log("| рынок | окно | пар | уплачено факт | прогноз по знаку | П/Ф | прогноз по магнитуде | П/Ф |");
console.log("|---|---|---|---|---|---|---|---|");
const jobs=[["BTC","truth-skept-raw/BTC_1761955200_1764547200.json","ноя.2025"],
            ["ETH","truth-skept-raw/ETH_1761955200_1764547200.json","ноя.2025"],
            ["SOL","truth-skept-raw/SOL_1761955200_1764547200.json","ноя.2025"],
            ["BTC","truth-skept-raw/BTC_1751936400_1753664400.json","июл.2025"]];
for(const [t,f,w] of jobs){
  if(!fs.existsSync(f)){console.log("нет файла",f);continue;}
  const a=calib(t,f,"sign"), b=calib(t,f,"mag");
  console.log(`| ${t} | ${w} | ${a.n} | $${Math.round(a.F).toLocaleString("ru-RU")} | $${Math.round(a.pred).toLocaleString("ru-RU")} | ${(a.pred/a.F).toFixed(3)} | $${Math.round(b.pred).toLocaleString("ru-RU")} | ${(b.pred/b.F).toFixed(3)} |`);
}
