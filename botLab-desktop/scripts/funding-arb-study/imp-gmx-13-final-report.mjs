import fs from "node:fs";
import { SP, q } from "./imp-gmx-lib.mjs";
const J = JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`, "utf8"));
const f = (x, d = 2) => (x == null ? "-" : (x >= 0 ? "+" : "") + x.toFixed(d));
const G = J.growth.pooled;
console.log("### Кривая impact(размер, сторона), 63 рынка GMX Arbitrum, 20.06.2025-20.06.2026, bps ноционала\n");
console.log("Знак сохранён: **+** значит GMX платит трейдеру, **-** значит трейдер платит.\n");
console.log("| размер сделки | A: шорт GMX, вход | A: круг сейчас | B: лонг GMX, вход | B: круг сейчас | n вход A/B |");
console.log("|---|---|---|---|---|---|");
const bands = G.preOpen_long.bands.map((b) => b.band);
const pick = (k, band) => G[k].bands.find((b) => b.band === band);
for (const b of bands) { const sa = pick("preOpen_short", b), la = pick("preOpen_long", b), sr = pick("postClose_short", b), lr = pick("postClose_long", b);
  console.log(`| ${b} | ${sa ? f(sa.medBps) : "-"} | ${sr ? f(sr.medBps) : "-"} | ${la ? f(la.medBps) : "-"} | ${lr ? f(lr.medBps) : "-"} | ${sa ? sa.n : 0} / ${la ? la.n : 0} |`); }
console.log(`\nНаклон МНК по log10 размера: вход в лонг GMX **${f(G.preOpen_long.slopeBpsPerDecade, 2)} bps на декаду** (58 рынков из 61 с тем же знаком), вход в шорт GMX ${f(G.preOpen_short.slopeBpsPerDecade, 2)} bps на декаду.`);
console.log(`Круг в нынешнем режиме: шорт ${f(G.postClose_short.slopeBpsPerDecade, 2)}, лонг ${f(G.postClose_long.slopeBpsPerDecade, 2)} bps на декаду.`);

console.log("\n### Ёмкость по факту прошедших сделок\n");
const mk = Object.entries(J.markets);
const maxes = Object.entries(J.tail.byMarket).map(([t, v]) => ({ t, s: v.maxTrade?.sizeUsd ?? 0 })).sort((a, b) => b.s - a.s);
console.log("| показатель | значение |"); console.log("|---|---|");
console.log(`| рынков всего | ${mk.length} |`);
console.log(`| исполненных сделок за год суммарно | ${Object.values(J.markets).reduce((a, b) => a + b.totalExecuted, 0).toLocaleString("en-US")} |`);
console.log(`| наблюдений в кривых | ${J.meta.observationsUsed.toLocaleString("en-US")} |`);
console.log(`| рынков без единой сделки >=$50k за год | ${J.meta.marketsWithNoTradeOver50k.length} (${J.meta.marketsWithNoTradeOver50k.join(", ")}) |`);
console.log(`| рынков без единой сделки >=$200k за год | ${J.meta.marketsWithNoTradeOver200k.length} |`);
console.log(`| медиана крупнейшей сделки года по рынку | $${Math.round(q(0.5, maxes.map((m) => m.s))).toLocaleString("en-US")} |`);
console.log(`| 25-й процентиль крупнейшей сделки года | $${Math.round(q(0.25, maxes.map((m) => m.s))).toLocaleString("en-US")} |`);
console.log(`| рынков, где крупнейшая сделка года < $100k | ${maxes.filter((m) => m.s < 1e5).length} |`);
console.log("\nКрупнейшие сделки года (топ-10):\n");
console.log("| рынок | размер | impact bps | сторона |"); console.log("|---|---|---|---|");
for (const m of maxes.slice(0, 10)) { const v = J.tail.byMarket[m.t].maxTrade;
  console.log(`| ${m.t} | $${Math.round(v.sizeUsd).toLocaleString("en-US")} | ${f(v.bps)} | ${v.isLong ? "лонг" : "шорт"} |`); }

console.log("\n### Режимы протокола\n");
console.log("| месяц | доля открытий с impact ровно ноль |"); console.log("|---|---|");
console.log("| июнь-август 2025 | 0.0% |"); console.log("| сентябрь 2025 | 88.5% |"); console.log("| октябрь 2025 - июнь 2026 | 100.0% |");
