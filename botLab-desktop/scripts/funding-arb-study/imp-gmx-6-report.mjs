import fs from "node:fs";
import { SP } from "./imp-gmx-lib.mjs";
const J = JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`, "utf8"));
const f = (x, d = 2) => (x == null ? "-" : (x >= 0 ? "+" : "") + x.toFixed(d));
const LBL = J.meta.labels;

console.log("### Сводная кривая impact(размер, сторона), все 63 рынка, bps (>0 = GMX платит)\n");
console.log("| корзина | шорт GMX (A): мед | p25 | p75 | n | лонг GMX (B): мед | p25 | p75 | n |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (let b = 0; b < 6; b++) { const s = J.pooled.short[b], l = J.pooled.long[b];
  console.log(`| ${LBL[b]} | ${f(s.med)} | ${f(s.p25)} | ${f(s.p75)} | ${s.n} | ${f(l.med)} | ${f(l.p25)} | ${f(l.p75)} | ${l.n} |`); }

console.log("\n### Круг открытие+закрытие, bps\n");
console.log("| корзина | A: откр | A: закр | A: круг | B: откр | B: закр | B: круг |");
console.log("|---|---|---|---|---|---|---|");
for (let b = 0; b < 6; b++) { const s = J.roundTrip.short[b], l = J.roundTrip.long[b];
  console.log(`| ${LBL[b]} | ${f(s.openMedBps)} | ${f(s.closeMedBps)} | **${f(s.roundTripMedBps)}** | ${f(l.openMedBps)} | ${f(l.closeMedBps)} | **${f(l.roundTripMedBps)}** |`); }

console.log("\n### По тирам свободной ликвидности GMX (медиана bps / n)\n");
const tiers = Object.keys(J.tiers).filter((k) => !k.includes("|")).sort();
console.log("| тир | " + LBL.join(" | ") + " |"); console.log("|" + "---|".repeat(7));
for (const t of tiers) console.log(`| ${t} | ` + J.tiers[t].map((r) => r.n ? `${f(r.med)} / ${r.n}` : "нет").join(" | ") + " |");

console.log("\n### Ёмкость по факту сделок: точное число исполненных сделок за год\n");
const ms = Object.entries(J.markets).sort((a, b) => b[1].totalExecuted - a[1].totalExecuted);
console.log("| рынок | сделок всего | >=$50k | >=$200k | своб.ликв. long $ | short $ | мед bps шорт(>=20k) | мед bps лонг(>=20k) |");
console.log("|---|---|---|---|---|---|---|---|");
const big = (m, b) => m.exactCountsByBucket[b].all;
const medAt = (m, side, b) => { const r = m.curves[side][b]; return r.n >= 10 ? f(r.med) : (r.n ? `${f(r.med)}(n=${r.n})` : "нет"); };
for (const [t, m] of ms) console.log(`| ${t} | ${m.totalExecuted} | ${big(m, 4) + big(m, 5)} | ${big(m, 5)} | ${Math.round(m.availLongUsd).toLocaleString("en-US")} | ${Math.round(m.availShortUsd).toLocaleString("en-US")} | ${medAt(m, "short", 3)} | ${medAt(m, "long", 3)} |`);

console.log("\n### Рост издержки с размером (МНК по log10 размера, bps на декаду)\n");
const g = Object.entries(J.growth).map(([t, v]) => ({ t, s: v.short?.slopeBpsPerDecade, l: v.long?.slopeBpsPerDecade }))
  .filter((r) => r.s != null || r.l != null);
const arr = (k) => g.map((r) => r[k]).filter((x) => x != null).sort((a, b) => a - b);
const med = (a) => a.length ? a[Math.floor(a.length / 2)] : null;
console.log(`рынков с оценкой наклона: шорт ${arr("s").length}, лонг ${arr("l").length}`);
console.log(`медианный наклон: шорт ${f(med(arr("s")), 3)} bps/декада, лонг ${f(med(arr("l")), 3)} bps/декада`);
console.log(`наклон<0 (издержка растёт с размером): шорт ${arr("s").filter((x) => x < 0).length}/${arr("s").length}, лонг ${arr("l").filter((x) => x < 0).length}/${arr("l").length}`);
console.log(`\nбез единой сделки >=$50k за год: ${J.meta.marketsWithNoTradeOver50k.length} рынков: ${J.meta.marketsWithNoTradeOver50k.join(", ")}`);
console.log(`без единой сделки >=$200k за год: ${J.meta.marketsWithNoTradeOver200k.length} рынков: ${J.meta.marketsWithNoTradeOver200k.join(", ")}`);
