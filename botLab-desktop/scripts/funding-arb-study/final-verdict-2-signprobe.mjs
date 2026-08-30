import fs from "node:fs";
import { all } from "./skept-cap-lib.mjs";
const E30=1e30, YR=3600*8760;
const UNI="AAVE ADA ARB AVAX BNB BTC DOGE DOT ENA ETH FARTCOIN GMX HYPE LINK LTC PENDLE PENGU PEPE SEI SOL SUI S TAO TRX UNI VIRTUAL XLM XRP".split(" ");
// Вопрос: в часах, где ЗНАК говорит одно, а порядок баз другое, велики ли ставки и деньги?
let agree=0,dis=0, flowAgree=0, flowDis=0, disRates=[];
const per={};
for(const t of UNI){
  const rows=all.get(t);
  const oi=JSON.parse(fs.readFileSync(`truth-a-oi2/${t}.json`,"utf8")).oi;
  const om=new Map(); for(const o of oi) om.set(o.snapshotTimestamp,o);
  per[t]={a:0,d:0,fa:0,fd:0};
  for(const r of rows){
    const o=om.get(r.tsHour); if(!o) continue;
    const bl=Number(o.longFundingBalanceOiUsd)/E30, bs=Number(o.shortFundingBalanceOiUsd)/E30;
    if(!(bl>0&&bs>0)) continue;
    const longPays = r.f_long<0;
    const payerBase = longPays?bl:bs, payerRate = Math.abs(longPays?r.f_long:r.f_short);
    const flow = payerRate*payerBase*3600;
    const consistent = longPays ? (bl>bs) : (bs>bl);   // платит БОЛЬШАЯ сторона (обычный режим)
    if(consistent){agree++;flowAgree+=flow;per[t].a++;per[t].fa+=flow;}
    else {dis++;flowDis+=flow;per[t].d++;per[t].fd+=flow; disRates.push(payerRate*YR*100);}
  }
}
disRates.sort((a,b)=>a-b);
const q=p=>disRates[Math.floor(p*(disRates.length-1))];
console.log("Часов, где платит БОЛЬШАЯ сторона (обычный режим):", agree, (100*agree/(agree+dis)).toFixed(2)+"%");
console.log("Часов, где платит МЕНЬШАЯ сторона (инерция динамического фандинга GMX):", dis, (100*dis/(agree+dis)).toFixed(2)+"%");
console.log("Поток $ в обычных часах:", Math.round(flowAgree).toLocaleString("ru-RU"), " в инерционных:", Math.round(flowDis).toLocaleString("ru-RU"),
  ` (${(100*flowDis/(flowAgree+flowDis)).toFixed(2)}% денег)`);
console.log("Ставка плательщика в инерционных часах, % годовых: p50", q(.5).toFixed(2), " p90", q(.9).toFixed(2), " max", q(1).toFixed(2));
console.log("\nпо именам (доля инерционных часов / доля инерционных денег):");
for(const t of UNI) console.log(" ", t.padEnd(9), (100*per[t].d/(per[t].a+per[t].d)).toFixed(1)+"%", (100*per[t].fd/(per[t].fa+per[t].fd)).toFixed(1)+"%");
