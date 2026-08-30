import fs from "node:fs";
import { all } from "./skept-cap-lib.mjs";
const E30=1e30;
const UNI="AAVE ADA ARB AVAX BNB BTC DOGE DOT ENA ETH FARTCOIN GMX HYPE LINK LTC PENDLE PENGU PEPE SEI SOL SUI S TAO TRX UNI VIRTUAL XLM XRP".split(" ");
for(const t of UNI){
  const rows=all.get(t); let oi;
  try{ oi=JSON.parse(fs.readFileSync(`truth-a-oi2/${t}.json`,"utf8")).oi; }catch(e){ console.log(t,"НЕТ ФАЙЛА"); continue; }
  const om=new Map(); for(const o of oi) om.set(o.snapshotTimestamp,o);
  let tot=0,sok=0,mok=0,miss=0;
  for(const r of rows){
    const o=om.get(r.tsHour); if(!o){miss++;continue;}
    const bl=Number(o.longFundingBalanceOiUsd)/E30, bs=Number(o.shortFundingBalanceOiUsd)/E30;
    if(!(bl>0&&bs>0)){miss++;continue;} tot++;
    if((r.f_long>0)===(bl<bs)) sok++;
    if((Math.abs(r.f_long)>Math.abs(r.f_short))===(bl<bs)) mok++;
  }
  const s=(100*sok/tot), m=(100*mok/tot);
  if(s<99.9||m<99.9) console.log(t, "часов",tot,"пропуск",miss,"знак",s.toFixed(2)+"%","магнитуда",m.toFixed(2)+"%");
}
console.log("готово");
