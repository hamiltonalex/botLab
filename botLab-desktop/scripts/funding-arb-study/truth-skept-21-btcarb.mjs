import fs from "node:fs";
import { pairs, split, loadCache } from "./truth-skept-4-calib2.mjs";
const E30=1e30;
function loadSrc(tok){ const s=JSON.parse(fs.readFileSync(`truth-a-src/${tok}.json`,"utf8")); const m=new Map();
  for(const r of s.funding) m.set(r.snapshotTimestamp,{fl:Number(r.fundingFactorPerSecondLong)/E30, fs:Number(r.fundingFactorPerSecondShort)/E30}); return m; }
const A=1751936400,B=1753664400;
const cm=loadCache("BTC"), sm=loadSrc("BTC"), ps=pairs(`truth-skept-raw/BTC_${A}_${B}.json`);
let F=0,PC=0,PS=0,n=0;
for(const x of ps){ if(x.a<A||x.b>B) continue;
  const a=split(cm,x.a,x.b,x.isLong), b=split(sm,x.a,x.b,x.isLong);
  if(a.noD>0||b.noD>0) continue; n++; F+=x.fund; PC+=x.held*a.payS; PS+=x.held*b.payS; }
let dif=0,tot=0;
for(let h=A;h<B;h+=3600){ const c=cm.get(h),s=sm.get(h); if(!c||!s) continue; tot++;
  const a=Math.abs(c.fl),q=Math.abs(s.fl); if(a===0&&q===0) continue;
  if(Math.abs(a-q)/Math.max(a,q)>=1e-3) dif++; }
console.log("BTC, окно максимума расхождений 2025-07-08..2025-07-28 ("+dif+" из "+tot+" часов расходятся >=0.1%)");
console.log("  пар интервалов:", n);
console.log("  фактически уплачено         $"+Math.round(F).toLocaleString("ru-RU"));
console.log("  прогноз по КЭШУ             $"+Math.round(PC).toLocaleString("ru-RU")+"   К/Ф "+(PC/F).toFixed(4));
console.log("  прогноз по СЕГОДНЯШНЕМУ ИСТ.$"+Math.round(PS).toLocaleString("ru-RU")+"   И/Ф "+(PS/F).toFixed(4));
