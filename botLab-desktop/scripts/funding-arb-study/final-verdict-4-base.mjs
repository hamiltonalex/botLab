import fs from "node:fs";
import { all } from "./skept-cap-lib.mjs";
const E30=1e30;
const UNI="AAVE ADA ARB AVAX BNB BTC DOGE DOT ENA ETH FARTCOIN GMX HYPE LINK LTC PENDLE PENGU PEPE SEI SOL SUI S TAO TRX UNI VIRTUAL XLM XRP".split(" ");
console.log("Сторона-ПОЛУЧАТЕЛЬ (та, у кого ставка положительная): её база фандинга в USD, по всем 8761 часу");
console.log("| имя | p10 | медиана | p90 | часов, где база получателя < $10 000 |");
console.log("|---|---|---|---|---|");
const glob=[];
for(const t of UNI){
  const rows=all.get(t);
  const oi=JSON.parse(fs.readFileSync(`truth-a-oi2/${t}.json`,"utf8")).oi;
  const om=new Map(); for(const o of oi) om.set(o.snapshotTimestamp,o);
  const v=[];
  for(const r of rows){const o=om.get(r.tsHour); if(!o) continue;
    const bl=Number(o.longFundingBalanceOiUsd)/E30, bs=Number(o.shortFundingBalanceOiUsd)/E30;
    if(!(bl>0&&bs>0)) continue;
    v.push(r.f_long>0?bl:bs);}
  v.sort((a,b)=>a-b); glob.push(...v);
  const q=p=>v[Math.floor(p*(v.length-1))];
  const small=v.filter(x=>x<1e4).length;
  console.log(`| ${t} | $${Math.round(q(.1)).toLocaleString("ru-RU")} | $${Math.round(q(.5)).toLocaleString("ru-RU")} | $${Math.round(q(.9)).toLocaleString("ru-RU")} | ${(100*small/v.length).toFixed(1)}% |`);
}
glob.sort((a,b)=>a-b);
const q=p=>glob[Math.floor(p*(glob.length-1))];
console.log(`\nВСЕ 28 ИМЁН: p10 $${Math.round(q(.1)).toLocaleString("ru-RU")}  медиана $${Math.round(q(.5)).toLocaleString("ru-RU")}  p90 $${Math.round(q(.9)).toLocaleString("ru-RU")}`);
console.log(`Часов, где база получателя меньше $10 000: ${(100*glob.filter(x=>x<1e4).length/glob.length).toFixed(1)}%; меньше $100 000: ${(100*glob.filter(x=>x<1e5).length/glob.length).toFixed(1)}%`);
