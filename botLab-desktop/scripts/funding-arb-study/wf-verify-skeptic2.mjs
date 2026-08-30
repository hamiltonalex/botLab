import { DATA as STUDY_DATA } from "./paths.mjs";
import { readFileSync } from "node:fs";
const P = STUDY_DATA;
const A = JSON.parse(readFileSync(`${P}/wf-walk-out.json`, "utf8"));
const live = [];
for (const t of ["BTC","ETH"]) for (const g of A.perToken[t].grid) live.push({t,...g});

const sum = (a,f)=>a.reduce((s,x)=>s+f(x),0);
console.log("[A] ЧТО ТАКОЕ -124.99");
console.log(" сырое среднее wf_net по 24 ячейкам      = $" + (sum(live,g=>g.wf_net)/24).toFixed(2));
console.log(" среднее ГОДОВОЕ wf_apr*2000 по 24        = $" + (sum(live,g=>g.wf_apr*2000)/24).toFixed(2));
console.log(" среднее net*8760/span по 24              = $" + (sum(live,g=>g.wf_net*8760/g.spanHours)/24).toFixed(2));
console.log(" длины окон (ч):", [...new Set(live.map(g=>g.spanHours))].join(","), "= годы", [...new Set(live.map(g=>(g.spanHours/8760).toFixed(3)))].join(","));

console.log("\n[B] ЦЕНА ЗАГЛЯДЫВАНИЯ ВПЕРЁД, при ОДИНАКОВОЙ ротации");
console.log(" (rotHind = та же сетка ротаций, но сторона взята задним числом; издержки те же)");
let tot=0, worse=0;
for (const g of live) {
  const rotHind = g.hindMatched_cfg === "A" ? g.rotA_net : g.rotB_net;
  const price = rotHind - g.wf_net;         // сколько бы дало знание будущего конфига
  const oraclePrice = g.oracle_net - g.wf_net;
  tot += price; if (price > 0.005) worse++;
  console.log(` ${g.t} W${g.W} H${g.H}: wf ${g.wf_net.toFixed(2)} | rotHind(${g.hindMatched_cfg}) ${rotHind.toFixed(2)} | цена годового конфига ${price>=0?"+":""}${price.toFixed(2)} | цена оракула окна +${oraclePrice.toFixed(2)} | hitHind ${(g.hitHindsight*100).toFixed(1)}%`);
}
console.log(` ИТОГ: цена знания годового конфига > 0 в ${worse}/24 ячейках, сумма $${tot.toFixed(2)}, среднее $${(tot/24).toFixed(2)}`);

console.log("\n[C] H=7: издержки против брутто оракула");
for (const H of [7,30,90]) {
  const c = live.filter(g=>g.H===H);
  const cost = sum(c.filter(g=>g.W===30), g=>g.wf_costs);
  console.log(` H=${H}: издержки одной пары (W=30) $${cost.toFixed(2)} | макс брутто оракула по ячейкам $${Math.max(...c.map(g=>g.oracle_net+g.wf_costs)).toFixed(2)} | оракул нетто отриц. в ${c.filter(g=>g.oracle_net<0).length}/8`);
}

console.log("\n[D] ВЗВЕШЕННАЯ ДОЛЯ ПОПАДАНИЙ");
const wSum=(f)=>sum(live,g=>f(g)*g.rebalances)/sum(live,g=>g.rebalances);
console.log(" BTC+ETH hitOracle взвеш. = " + (wSum(g=>g.hitOracle)*100).toFixed(1) + "%, решений " + sum(live,g=>g.rebalances));
console.log(" BTC+ETH hitHindsight взвеш. = " + (wSum(g=>g.hitHindsight)*100).toFixed(1) + "%");
const ap=A.perToken.APT.grid;
console.log(" APT hitOracle взвеш. = " + (sum(ap,g=>g.hitOracle*g.rebalances)/sum(ap,g=>g.rebalances)*100).toFixed(1) + "%, решений " + sum(ap,g=>g.rebalances));
console.log(" W=180 hitHindsight:", live.filter(g=>g.W===180).map(g=>`${g.t}H${g.H} ${(g.hitHindsight*100).toFixed(0)}%`).join(" "));

console.log("\n[E] ГЕЙТ");
const gate = live.filter(g=>g.wfGate_net>0);
console.log(" плюсовых ячеек с гейтом BTC+ETH: " + gate.length + " -> " + gate.map(g=>`${g.t} W${g.W}H${g.H} +$${g.wfGate_net.toFixed(2)} (${(g.wfGate_apr*100).toFixed(2)}%)`).join(" | "));
console.log(" ETH с гейтом плюсовых: " + live.filter(g=>g.t==="ETH"&&g.wfGate_net>0).length + "/12");
