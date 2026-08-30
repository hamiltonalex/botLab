import fs from "node:fs";
import { all } from "./skept-cap-lib.mjs";
const rows = all.get("BOME");
// найти самую длинную серию одинаковых f_long
let best = { n: 0 }, run = 1;
for (let i = 1; i < rows.length; i++) {
  if (rows[i].f_long === rows[i-1].f_long) { run++; if (run > best.n) best = { n: run, end: i, v: rows[i].f_long }; }
  else run = 1;
}
const s = best.end - best.n + 1;
console.log(`BOME: серия ${best.n} одинаковых часов`);
console.log(`  с ${rows[s].ts} по ${rows[best.end].ts}`);
console.log(`  f_long = ${rows[s].f_long}  (${(100*rows[s].f_long*3600*8760).toLocaleString("ru-RU",{maximumFractionDigits:0})}% годовых)`);
console.log(`  f_short = ${rows[s].f_short}, b_long = ${rows[s].b_long}, b_short = ${rows[s].b_short}`);
console.log(`  hl_rate меняется? ${new Set(rows.slice(s, best.end+1).map(r=>r.hl_rate)).size} разных значений на ${best.n} часов`);
console.log(`\nСЕКУНДЫ для сверки: ${rows[s].tsHour} .. ${rows[best.end].tsHour}`);
