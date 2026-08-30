import { CACHE as STUDY_CACHE } from "./paths.mjs";
// wf-data-majors.mjs - где именно в кросс-секции сидит плюс: в ликвидных именах или в хвосте.
// Правила из движка: parseSpreadCsv, scanTwoLeg, pnlPath, DEFAULT_COSTS/roundTripCost, nEff/ci95.

import { readFileSync, readdirSync } from "node:fs";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { scanTwoLeg, pnlPath, mean, median, fractionPositive } from "../../src/engine/math.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";

const SC = STUDY_CACHE;
const WIN = "_1750402800_1781938800.csv";
const NOTIONAL = 2000;
const FULL = 8761;
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "n/a");

// «Ликвидные имена» = крупные бессрочники, у которых стакан выдержит размер. Список задан руками
// и назван явно, потому что открытого интереса GMX в этом кэше нет: это ОПОРА ЗАМЕРА, не результат.
const MAJORS = new Set(["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "AVAX", "LINK", "LTC", "ADA", "TRX", "DOT", "SUI", "HYPE", "AAVE", "NEAR", "ARB", "OP", "TAO", "UNI", "BCH", "XLM", "FIL"]);

const rows = [];
for (const n of readdirSync(SC).filter((x) => x.endsWith(WIN))) {
  const token = n.slice(0, -WIN.length);
  const r = parseSpreadCsv(readFileSync(`${SC}/${n}`, "utf8"));
  if (r.length !== FULL) continue;
  const two = scanTwoLeg(r, { token });
  const netUsd = pnlPath(two.net, NOTIONAL).total - roundTripCost(DEFAULT_COSTS, NOTIONAL, false);
  rows.push({ token, netUsd, apr: two.chosen === "A" ? two.A.netMean : two.B.netMean, major: MAJORS.has(token) });
}

const mj = rows.filter((r) => r.major);
const rest = rows.filter((r) => !r.major);
console.log(`## Ликвидные имена против хвоста (полный год, двухногая, $2000)\n`);
console.log(`| группа | токенов | медиана нетто $ | среднее нетто $ | доля с плюсом | медиана APR |`);
console.log(`|---|---|---|---|---|---|`);
for (const [name, g] of [["ликвидные (список задан руками)", mj], ["остальные", rest], ["все", rows]]) {
  console.log(`| ${name} | ${g.length} | ${f(median(g.map((x) => x.netUsd)))} | ${f(mean(g.map((x) => x.netUsd)))} | ${pct(fractionPositive(g.map((x) => x.netUsd)))} | ${f(median(g.map((x) => x.apr)), 4)} |`);
}
console.log(`\nСписок ликвидных, попавших в корпус: ${mj.map((x) => x.token).sort().join(", ")}`);

// знаковый тест на кросс-секции с поправкой на эффективное число инструментов
function logC(n, k) { let s = 0; for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1); return s; }
function binomTail(n, k) { let s = 0; for (let i = k; i <= n; i++) s += Math.exp(logC(n, i) - n * Math.LN2); return s; }
const posAll = rows.filter((x) => x.netUsd > 0).length;
const posMj = mj.filter((x) => x.netUsd > 0).length;
console.log(`\nЗнаковый тест (H0: плюс и минус равновероятны):`);
console.log(`  все ${rows.length} токенов: ${posAll} с плюсом, односторонний p = ${binomTail(rows.length, posAll).toExponential(2)}`);
const kEff = 39; // из wf-data-crosssection.mjs
const scaled = Math.round(posAll / rows.length * kEff);
console.log(`  с поправкой на k_eff=${kEff}: ${scaled} из ${kEff}, p = ${binomTail(kEff, scaled).toExponential(2)}`);
console.log(`  только ликвидные (${mj.length}): ${posMj} с плюсом, p = ${binomTail(mj.length, posMj).toExponential(2)}`);
