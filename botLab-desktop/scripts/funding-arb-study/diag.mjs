import fs from "node:fs";
import { all, YEAR, SP, scanTwoLeg, annualizeRow, maxOf, median } from "./skept-cap-lib.mjs";
const cap63 = JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8"));
const VOL = JSON.parse(fs.readFileSync(`${SP}/vol63.json`, "utf8"));
const med = (xs) => { const a = xs.slice().sort((x,y)=>x-y); return a.length ? (a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2) : NaN; };

console.log(`# ПИКОВАЯ ЧАСОВАЯ |net APR| ПО ВСЕЙ ВСЕЛЕННОЙ (годовые доли, 1.0 = 100%)\n`);
const rows = cap63.map((r) => {
  const rr = all.get(r.t);
  const ann = rr.map(annualizeRow);
  const peak = maxOf(ann.map((a) => Math.max(Math.abs(a.net_A), Math.abs(a.net_B))));
  const medA = median(ann.map((a) => a.net_A));
  const v = (VOL[r.t] || []).map((c) => c.ntl).filter(Number.isFinite);
  return { t: r.t, peak, medA, hlMed: med(v), avail: Math.max(r.availLong, r.availShort), name: r.name };
}).sort((a, b) => b.peak - a.peak);
console.log(`| токен | пик |netAPR| | медиана net_A | медиана оборота HL $ | avail GMX $ |`);
console.log(`|---|---|---|---|---|`);
for (const r of rows.slice(0, 15)) console.log(`| ${r.t} | ${r.peak.toExponential(2)} | ${(100*r.medA).toFixed(1)}% | ${(r.hlMed/1e6).toFixed(1)}M | ${(r.avail/1000).toFixed(0)}k |`);
console.log(`\n...`);
for (const r of rows.slice(-5)) console.log(`| ${r.t} | ${r.peak.toFixed(2)} | ${(100*r.medA).toFixed(1)}% | ${(r.hlMed/1e6).toFixed(1)}M | ${(r.avail/1000).toFixed(0)}k |`);

const wild = rows.filter((r) => r.peak > 100);
console.log(`\nИмён с пиковой часовой ставкой выше 10000% годовых: ${wild.length} из 63`);
console.log(`  ${wild.map((r) => `${r.t}(${r.peak.toExponential(1)})`).join(", ")}`);
console.log(`\nУ НИХ ЕСТЬ ОБОРОТ НА HL: медиана ${(med(wild.map(r=>r.hlMed))/1e6).toFixed(1)}M в сутки.`);
console.log(`Поэтому фильтр ёмкости их НЕ РЕЖЕТ: ликвидность на Hyperliquid у них настоящая,`);
console.log(`а вырождена сторона GMX, ёмкость которой фильтр меряет объёмом, а не вменяемостью ставки.`);
