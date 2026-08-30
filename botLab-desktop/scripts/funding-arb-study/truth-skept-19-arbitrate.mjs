import fs from "node:fs";
import { pairs, split, loadCache } from "./truth-skept-4-calib2.mjs";
const E30=1e30;
function loadSrc(tok){
  const s=JSON.parse(fs.readFileSync(`truth-a-src/${tok}.json`,"utf8"));
  const m=new Map();
  for(const r of s.funding) m.set(r.snapshotTimestamp,{fl:Number(r.fundingFactorPerSecondLong)/E30, fs:Number(r.fundingFactorPerSecondShort)/E30});
  return m;
}
console.log("АРБИТРАЖ ДВУХ ВЫГРУЗОК ДЕНЬГАМИ: кто ближе к фактически уплаченному фандингу?");
console.log("(метод: часы, где наша сторона плательщик; фандинг из fundingFeeAmount*цена/1e30)");
console.log("рынок  окно            уплачено факт $     прогноз по КЭШУ $  К/Ф      прогноз по ИСТОЧНИКУ $  И/Ф     часов расх.>=0.1%");
const CAL=[["BTC","truth-skept-raw/BTC_1761955200_1764547200.json"],["ETH","truth-skept-raw/ETH_1761955200_1764547200.json"],["SOL","truth-skept-raw/SOL_1761955200_1764547200.json"]];
const DIRTY=["FET","S","BERA","EIGEN","TIA","LDO","BONK","WLD","INJ","POL","MOODENG","WIF","ORDI","FLOKI","AIXBT","STX","MEME","BOME"];
function go(tok,file,label){
  const cm=loadCache(tok), sm=loadSrc(tok), ps=pairs(file);
  let F=0,PC=0,PS=0;
  for(const x of ps){
    const a=split(cm,x.a,x.b,x.isLong); if(a.noD>0) continue;
    const b=split(sm,x.a,x.b,x.isLong); if(b.noD>0) continue;
    F+=x.fund; PC+=x.held*a.payS; PS+=x.held*b.payS;
  }
  // сколько часов рынка разошлось на >=0.1%
  let dif=0,tot=0;
  for(const [h,v] of cm){ const s=sm.get(h); if(!s) continue; tot++;
    for(const k of ["fl","fs"]){ const c=Math.abs(v[k]),q=Math.abs(s[k]);
      if(c===0&&q===0) continue;
      if(Math.abs(c-q)/Math.max(c,q,1e-300)>=1e-3){dif++;break;} } }
  console.log(tok.padEnd(7),label.padEnd(15),("$"+Math.round(F).toLocaleString("ru-RU")).padStart(15),
    ("$"+Math.round(PC).toLocaleString("ru-RU")).padStart(20),(PC/F).toFixed(3).padStart(6),
    ("$"+Math.round(PS).toLocaleString("ru-RU")).padStart(22),(PS/F).toFixed(3).padStart(6),
    (dif+"/"+tot+" ("+(100*dif/tot).toFixed(1)+"%)").padStart(20));
  return {F,PC,PS};
}
let A={F:0,PC:0,PS:0};
for(const [t,f] of CAL){ const r=go(t,f,"ноя.2025, 30 сут"); A.F+=r.F;A.PC+=r.PC;A.PS+=r.PS; }
console.log("  ИТОГО калибровочные: факт $"+Math.round(A.F).toLocaleString("ru-RU")+"  кэш "+(A.PC/A.F).toFixed(4)+"  источник "+(A.PS/A.F).toFixed(4));
let B={F:0,PC:0,PS:0};
for(const t of DIRTY){ const r=go(t,`truth-b-raw/${t}.json`,"полный год"); B.F+=r.F;B.PC+=r.PC;B.PS+=r.PS; }
console.log("  ИТОГО 18 грязных: факт $"+Math.round(B.F).toLocaleString("ru-RU")+"  кэш "+(B.PC/B.F).toFixed(4)+"  источник "+(B.PS/B.F).toFixed(4));
