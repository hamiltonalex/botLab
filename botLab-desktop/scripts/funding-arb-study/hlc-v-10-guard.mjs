// hlc-v-10: сторожевые пробы. Изоляция ног, знаки, сходимость двух независимых источников Binance.
import fs from "node:fs";
import { all, YEAR } from "./skept-cap-lib.mjs";
import { runLegs, hourlyOnlyRows, ann, parseMv } from "./hlc-v-lib.mjs";
const N = 10000;
const rows = all.get("BTC");
// 1. синтетические строки действительно изолируют ногу: GMX-часть строго ноль
const s = runLegs({ rows: hourlyOnlyRows(rows.map((r) => [r.tsHour, r.hl_rate])), config: "B", notional: N, rtCost: 0 });
console.log(`1. изоляция: dPnlGmx = ${s.gmx} (должен быть 0), расчётов HL ${s.sett} из ${rows.length} часов`);
// 2. синтетическая нога HL совпадает с ногой HL из полного двуногого прогона
const f = runLegs({ rows, config: "B", notional: N, rtCost: 0 });
console.log(`2. нога HL синтетика ${s.hl.toFixed(6)} против полного прогона ${f.hl.toFixed(6)}; разница ${(s.hl - f.hl).toExponential(2)}`);
// 3. смена конфига переворачивает знак ноги HL
const a = runLegs({ rows, config: "A", notional: N, rtCost: 0 });
console.log(`3. конфиг A нога HL ${a.hl.toFixed(2)} = -(конфиг B ${f.hl.toFixed(2)})? ${(Math.abs(a.hl + f.hl) < 1e-6)}`);
// 4. два независимых источника ставки Binance по BTC за общее окно
const bin = JSON.parse(fs.readFileSync("hlc-bin-funding.json", "utf8")).BTC.rows;
const m = new Map(); for (const [t, r] of bin) { const e = Math.floor(t / 3600000) * 3600; for (let k = 1; k <= 8; k++) m.set(e - k * 3600, r / 8); }
const mv = parseMv("mv_btc_1688616000_1781726400.csv").filter((r) => r.tsHour >= rows[0].tsHour && m.has(r.tsHour));
const mine = runLegs({ rows: hourlyOnlyRows(mv.map((r) => [r.tsHour, -m.get(r.tsHour)])), config: "B", notional: N, rtCost: 0 });
const theirs = runLegs({ rows: hourlyOnlyRows(mv.map((r) => [r.tsHour, -r.ns_bin])), config: "B", notional: N, rtCost: 0 });
console.log(`4. лонг Binance BTC за ${mv.length} ч: мой разбор истории ${(100 * ann(mine.hl, N, mine.hours)).toFixed(3)}%/год, колонка ns_binance из кэша ${(100 * ann(theirs.hl, N, theirs.hours)).toFixed(3)}%/год`);
// 5. перевёрнутый знак Binance даёт зеркальный ответ (проба на подгонку)
const flip = runLegs({ rows: hourlyOnlyRows(mv.map((r) => [r.tsHour, +m.get(r.tsHour)])), config: "B", notional: N, rtCost: 0 });
console.log(`5. проба на переворот: +ставка даёт ${(100 * ann(flip.hl, N, flip.hours)).toFixed(3)}%, зеркало ${(Math.abs(flip.hl + mine.hl) < 1e-6)}`);
// 6. разбавление GMX не трогает часы, где мы платим
console.log(`6. монет с полным годом ${[...all.values()].filter((r) => r.length === YEAR).length}; часов у BTC ${rows.length}`);
