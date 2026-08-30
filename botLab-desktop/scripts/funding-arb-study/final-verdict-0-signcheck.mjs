import fs from "node:fs";
import { all, YEAR } from "./skept-cap-lib.mjs";
const E30=1e30;
const UNI="AAVE ADA ARB AVAX BNB BTC DOGE DOT ENA ETH FARTCOIN GMX HYPE LINK LTC PENDLE PENGU PEPE SEI SOL SUI S TAO TRX UNI VIRTUAL XLM XRP".split(" ");
let ok=0,bad=0,noOi=0,tot=0, sameSign=0;
for(const t of UNI){
  const rows=all.get(t); let oi;
  try{ oi=JSON.parse(fs.readFileSync(`truth-a-oi2/${t}.json`,"utf8")).oi; }catch(e){ console.log("нет oi:",t); continue; }
  const om=new Map(); for(const o of oi) om.set(o.snapshotTimestamp,o);
  for(const r of rows){
    const o=om.get(r.tsHour); if(!o){noOi++;continue;}
    const bl=Number(o.longFundingBalanceOiUsd)/E30, bs=Number(o.shortFundingBalanceOiUsd)/E30;
    if(!(bl>0&&bs>0)) {noOi++;continue;}
    tot++;
    if(Math.sign(r.f_long)===Math.sign(r.f_short)) sameSign++;
    // гипотеза: положительная ставка = сторона ПОЛУЧАЕТ, значит у неё МЕНЬШАЯ база
    const longPositive = r.f_long>0;
    const longSmaller = bl<bs;
    if(longPositive===longSmaller) ok++; else bad++;
  }
}
console.log({tot,ok,bad,noOi,sameSign, доля_ok:(ok/tot*100).toFixed(3)+"%"});
