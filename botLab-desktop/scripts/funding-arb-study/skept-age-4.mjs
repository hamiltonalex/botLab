import fs from "node:fs";
import { loadY2, listingMap, MAJORS, SP } from "./skept-age-lib.mjs";
const y2 = loadY2(); const L = listingMap();
console.log(`# ЧТО ТАКОЕ listingDate: сверка с ПЕРВОЙ строкой данных (качалка стартовала 2023-07-06)`);
console.log(`| токен | рынок GMX (mi.json) | адрес совпал | listingDate | 1-я строка y2 | сдвиг сут | 1-й ненулевой факт GMX | сдвиг сут |`);
console.log(`|---|---|---|---|---|---|---|---|`);
const nzOf = (rows) => rows.find((r) => r.f_long || r.f_short || r.b_long || r.b_short);
const rowsOut = [];
for (const t of MAJORS) {
  const r = y2.get(t); const a = L.addr.get(t); const m = L.byAddr.get(a);
  if (!r?.length) { console.log(`| ${t} | ${m?.name ?? "?"} | ${m?"да":"НЕТ"} | ${L.dateOf(t)||"?"} | нет файла | - | - | - |`); continue; }
  const ld = L.dateOf(t), first = r[0].ts.slice(0, 10);
  const d1 = (Date.parse(first) - Date.parse(ld)) / 86400000;
  const nz = nzOf(r); const nzd = nz ? nz.ts.slice(0,10) : null;
  const d2 = nz ? (Date.parse(nzd) - Date.parse(ld)) / 86400000 : null;
  console.log(`| ${t} | ${m?.name ?? "НЕТ В mi.json"} | ${m?"да":"НЕТ"} | ${ld||"?"} | ${first} | ${d1>=0?"+":""}${d1.toFixed(0)} | ${nzd ?? "-"} | ${d2==null?"-":(d2>=0?"+":"")+d2.toFixed(0)} |`);
  rowsOut.push({ t, ld, first, d1, nzd, d2 });
}
console.log(`\n# ПРОВЕРКА ОПОРНОЙ ТОЧКИ: BTC/ETH должны быть 2023-08-08 (запуск GMX V2)`);
for (const t of ["BTC","ETH","SOL","XRP","DOGE","LINK","LTC","ARB","UNI"]) console.log(`  ${t.padEnd(5)} listingDate=${L.dateOf(t)}  рынок=${L.byAddr.get(L.addr.get(t))?.name}`);
const cohort = new Set(["BTC","ETH","SOL","XRP","DOGE","LINK","LTC","ARB","UNI"].map(t=>L.dateOf(t)));
console.log(`  разных дат в стартовой когорте: ${[...cohort].join(", ")}`);
console.log(`\n# ГДЕ listingDate РАСХОДИТСЯ С ДАННЫМИ`);
for (const r of rowsOut) if (Math.abs(r.d1) > 1 && r.first > "2023-09-26")
  console.log(`  ${r.t.padEnd(5)} listingDate ${r.ld}, данные с ${r.first} (${r.d1>0?"позже":"РАНЬШЕ ЛИСТИНГА"} на ${Math.abs(r.d1)} сут), первый ненулевой факт GMX ${r.nzd}`);
console.log(`\n# ОБРЕЗКА КАЧАЛКИ: сколько имён упирается в один и тот же старт`);
const cnt = new Map(); for (const r of rowsOut) cnt.set(r.first, (cnt.get(r.first)||0)+1);
for (const [d,n] of [...cnt].sort()) if (n>1) console.log(`  ${d}: ${n} имён`);
console.log(`\n# ВСЕ ДАТЫ ЛИСТИНГА В mi.json (133 рынка) - распределение по месяцам`);
const mm = new Map();
for (const m of JSON.parse(fs.readFileSync(`${SP}/mi.json`,"utf8")).markets) { const k=(m.listingDate||"?").slice(0,7); mm.set(k,(mm.get(k)||0)+1); }
console.log([...mm].sort().map(([k,v])=>`${k}:${v}`).join("  "));
