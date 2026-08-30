import fs from "node:fs";
import { all } from "./skept-cap-lib.mjs";
const E30=1e30;
const UNI="AAVE ADA ARB AVAX BNB BTC DOGE DOT ENA ETH FARTCOIN GMX HYPE LINK LTC PENDLE PENGU PEPE SEI SOL SUI S TAO TRX UNI VIRTUAL XLM XRP".split(" ");
const EARN="PENGU BNB DOT PEPE SEI TAO TRX VIRTUAL ADA XLM PENDLE".split(" ");
let tot=0, earn=0; const per={};
for(const t of UNI){
  const rows=all.get(t);
  const oi=JSON.parse(fs.readFileSync(`truth-a-oi2/${t}.json`,"utf8")).oi;
  const om=new Map(); for(const o of oi) om.set(o.snapshotTimestamp,o);
  let f=0;
  for(const r of rows){const o=om.get(r.tsHour); if(!o) continue;
    const bl=Number(o.longFundingBalanceOiUsd)/E30, bs=Number(o.shortFundingBalanceOiUsd)/E30;
    if(!(bl>0&&bs>0)) continue;
    const longPays=r.f_long<0;
    f += Math.abs(longPays?r.f_long:r.f_short)*(longPays?bl:bs)*3600;}
  per[t]=f; tot+=f; if(EARN.includes(t)) earn+=f;
}
const s=Object.entries(per).sort((a,b)=>b[1]-a[1]);
console.log("# ВЕСЬ ФАНДИНГ, УПЛАЧЕННЫЙ ВСЕМИ УЧАСТНИКАМИ ЗА ГОД, чистая вселенная 28 имён");
for(const [t,v] of s) console.log(`  ${t.padEnd(9)} $${Math.round(v).toLocaleString("ru-RU")}`);
console.log(`\nВСЕГО по 28 именам: $${Math.round(tot).toLocaleString("ru-RU")}`);
console.log(`Из них BTC+ETH+SOL+LINK+XRP: $${Math.round(per.BTC+per.ETH+per.SOL+per.LINK+per.XRP).toLocaleString("ru-RU")} (${(100*(per.BTC+per.ETH+per.SOL+per.LINK+per.XRP)/tot).toFixed(1)}%) - бот на них не зарабатывает`);
console.log(`11 имён, дающих всю прибыль прогона: $${Math.round(earn).toLocaleString("ru-RU")} (${(100*earn/tot).toFixed(1)}% котла)`);
console.log(`Порог заказчика $25 000-30 000 это ${(100*27500/earn).toFixed(1)}% ВСЕГО фандинга этих 11 рынков за год.`);
