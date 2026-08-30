import fs from "node:fs";
import { loadCache, split, pairs } from "./truth-skept-4-calib2.mjs";
const YR=3600*8760;
const TOK=["FET","S","MOODENG","BERA","FLOKI","EIGEN","WLD","STX","BONK","MEME","BOME","ORDI","TIA","LDO","WIF","AIXBT","INJ","POL"];
console.log("ТОТ ЖЕ МЕТОД, ПРОВЕРЕННЫЙ НА BTC/ETH, НА 18 ГРЯЗНЫХ РЫНКАХ (полный год)");
console.log("тк      пар   уплачено $   прогноз(часы плат.)  П/Ф   прогноз(все часы)  П/Ф(все)   ноц-ч(плат)  ставка ФАКТ %год");
let SF=0,SP=0,SA=0;
const rows=[];
for(const t of TOK){
  const cm=loadCache(t), ps=pairs(`truth-b-raw/${t}.json`);
  let F=0,predPay=0,predAll=0,ntPay=0,ntAll=0,skip=0;
  for(const x of ps){
    const s=split(cm,x.a,x.b,x.isLong);
    if(s.noD>0){skip++;continue;}
    F+=x.fund; predPay+=x.held*s.payS; predAll+=x.held*(s.payS+s.recS);
    ntPay+=x.held*s.payD; ntAll+=x.held*x.dt;
  }
  SF+=F;SP+=predPay;SA+=predAll;
  rows.push({t,n:ps.length,F,predPay,predAll,ntPay});
  console.log(t.padEnd(8),String(ps.length).padStart(6),
    ("$"+Math.round(F).toLocaleString("ru-RU")).padStart(12),
    ("$"+Math.round(predPay).toLocaleString("ru-RU")).padStart(20),
    (predPay/F).toFixed(3).padStart(6),
    ("$"+Math.round(predAll).toLocaleString("ru-RU")).padStart(18),
    (predAll/F).toFixed(2).padStart(9),
    (ntPay/3600).toExponential(2).padStart(12),
    (F/ntPay*YR*100).toFixed(1).padStart(16));
}
console.log("\nИТОГО 18 рынков: уплачено $"+Math.round(SF).toLocaleString("ru-RU")+
  "  прогноз(часы плательщика) $"+Math.round(SP).toLocaleString("ru-RU")+"  отношение "+(SP/SF).toFixed(4));
console.log("для сравнения, прогноз БЕЗ разделения сторон $"+Math.round(SA).toLocaleString("ru-RU")+" отношение "+(SA/SF).toFixed(3));
