import fs from "node:fs";
import { SP } from "./skept-cap-lib.mjs";
// Перевернуть стороны = сделать нашу (меньшую) сторону больше противоположной.
// Нужен размер N > (база_большой - база_нашей). Считаем по 11 именам, которые дают всю прибыль.
const EARN = ["PENGU","BNB","DOT","PEPE","SEI","TAO","TRX","VIRTUAL","LINK","XRP","ADA"];
const med = (a) => { const x = a.slice().sort((p,q)=>p-q); return x.length ? x[Math.floor(x.length/2)] : NaN; };
const fm = (x) => !Number.isFinite(x) ? "н/д" : x >= 1e6 ? `$${(x/1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x/1e3).toFixed(0)}k` : `$${x.toFixed(0)}`;
console.log(`| рынок | медиана МЕНЬШЕЙ стороны | медиана БОЛЬШЕЙ | нужно для переворота | наша позиция при $300k |`);
console.log(`|---|---|---|---|---|`);
for (const t of EARN) {
  const p = `${SP}/truth-a-oi2/${t}.json`; if (!fs.existsSync(p)) { console.log(`| ${t} | нет данных |`); continue; }
  const oi = JSON.parse(fs.readFileSync(p, "utf8")).oi;
  const small = [], big = [], flip = [];
  for (const r of oi) {
    const L = Number(r.longFundingBalanceOiUsd)/1e30, S = Number(r.shortFundingBalanceOiUsd)/1e30;
    if (!(L > 0) || !(S > 0)) continue;
    small.push(Math.min(L,S)); big.push(Math.max(L,S)); flip.push(Math.abs(L-S));
  }
  console.log(`| ${t} | ${fm(med(small))} | ${fm(med(big))} | ${fm(med(flip))} | $100k |`);
}
console.log(`\nДоля часов, где наша позиция $100k БОЛЬШЕ разницы сторон (то есть переворачивает рынок):`);
for (const t of EARN) {
  const p = `${SP}/truth-a-oi2/${t}.json`; if (!fs.existsSync(p)) continue;
  const oi = JSON.parse(fs.readFileSync(p, "utf8")).oi;
  let n = 0, tot = 0;
  for (const r of oi) {
    const L = Number(r.longFundingBalanceOiUsd)/1e30, S = Number(r.shortFundingBalanceOiUsd)/1e30;
    if (!(L > 0) || !(S > 0)) continue; tot++;
    if (100000 > Math.abs(L - S)) n++;
  }
  console.log(`  ${t.padEnd(9)} ${(100*n/tot).toFixed(1)}%`);
}
