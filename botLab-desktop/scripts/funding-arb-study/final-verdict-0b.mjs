import fs from "node:fs";
import { all } from "./skept-cap-lib.mjs";
const E30=1e30;
const UNI="AAVE BTC ETH SOL PEPE DOT".split(" ");
for(const t of UNI){
  const rows=all.get(t);
  const oi=JSON.parse(fs.readFileSync(`truth-a-oi2/${t}.json`,"utf8")).oi;
  const om=new Map(); for(const o of oi) om.set(o.snapshotTimestamp,o);
  let magOk=0,tot=0,lp=0, id=0, worst=0;
  for(const r of rows){
    const o=om.get(r.tsHour); if(!o) continue;
    const bl=Number(o.longFundingBalanceOiUsd)/E30, bs=Number(o.shortFundingBalanceOiUsd)/E30;
    if(!(bl>0&&bs>0)) continue; tot++;
    if((Math.abs(r.f_long)>Math.abs(r.f_short))===(bl<bs)) magOk++;
    if(r.f_long>0) lp++;
    const a=Math.abs(r.f_long)*bl, b=Math.abs(r.f_short)*bs;
    const e=Math.abs(a-b)/Math.max(a,b); if(e>worst) worst=e;
    if(e<1e-4) id++;
  }
  console.log(t, "часов",tot, "магнитуда~база", (100*magOk/tot).toFixed(2)+"%", "f_long>0", (100*lp/tot).toFixed(1)+"%", "тождество", (100*id/tot).toFixed(4)+"%", "худшая ошибка", worst.toExponential(2));
}
// показать несколько строк
const t="BTC", rows=all.get(t);
const oi=JSON.parse(fs.readFileSync(`truth-a-oi2/${t}.json`,"utf8")).oi;
const om=new Map(); for(const o of oi) om.set(o.snapshotTimestamp,o);
for(let i=0;i<5;i++){const r=rows[i],o=om.get(r.tsHour);
  console.log(r.ts, "f_long",r.f_long, "f_short",r.f_short, "bl",(Number(o.longFundingBalanceOiUsd)/E30).toFixed(0), "bs",(Number(o.shortFundingBalanceOiUsd)/E30).toFixed(0));}
