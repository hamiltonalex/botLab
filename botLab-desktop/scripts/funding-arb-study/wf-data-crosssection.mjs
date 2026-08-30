import { CACHE as STUDY_CACHE } from "./paths.mjs";
// wf-data-crosssection.mjs - весь найденный корпус ставок, а не три фикстуры. Только чтение.
//
// Правила зовутся из движка: parseSpreadCsv, scanTwoLeg, scanOneLeg, pnlPath, maxDrawdownFraction,
// DEFAULT_COSTS + roundTripCost, nEff/ci95 из otmscan/stats.js. Свои здесь только описательные
// сводки и кросс-корреляция (правил начисления не дублируют).

import { readFileSync, readdirSync } from "node:fs";
import { parseSpreadCsv } from "../../src/engine/format.js";
import {
  scanTwoLeg,
  scanOneLeg,
  pnlPath,
  maxDrawdownFraction,
  mean,
  median,
  fractionPositive,
  HOURS_PER_YEAR,
} from "../../src/engine/math.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";
import { nEff, ci95, sd } from "../../src/engine/otmscan/stats.js";

const SC = STUDY_CACHE;
const WIN = "_1750402800_1781938800.csv";
const NOTIONAL = 2000;
const FULL = 8761;
const fin = (x) => Number.isFinite(x);
const f = (x, d = 4) => (fin(x) ? x.toFixed(d) : "n/a");
const pct = (x, d = 1) => (fin(x) ? (x * 100).toFixed(d) + "%" : "n/a");
const q = (a, p) => { const s = a.filter(fin).slice().sort((x, y) => x - y); if (!s.length) return NaN;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };

const files = readdirSync(SC).filter((n) => n.endsWith(WIN)).sort();
const rec = [];
for (const n of files) {
  const token = n.slice(0, -WIN.length);
  const rows = parseSpreadCsv(readFileSync(`${SC}/${n}`, "utf8"));
  const two = scanTwoLeg(rows, { token });
  const one = scanOneLeg(rows, { token });
  if (!two || !one) continue;
  const netSeries = two.net;
  const gross = pnlPath(netSeries, NOTIONAL).total;
  const netUsd = gross - roundTripCost(DEFAULT_COSTS, NOTIONAL, false);
  const grossOne = pnlPath(one.net, NOTIONAL).total;
  const netOneUsd = grossOne - roundTripCost(DEFAULT_COSTS, NOTIONAL, true);
  rec.push({
    token, rows, hours: two.hours, chosen: two.chosen, two, one,
    netSeries, gross, netUsd, grossOne, netOneUsd,
    mAPR: two.chosen === "A" ? two.A.netMean : two.B.netMean,
    ne: nEff(netSeries), band: ci95(netSeries),
    dd: maxDrawdownFraction(netSeries),
  });
}

console.log(`## 1 · Корпус\n`);
console.log(`Файлов в spread_cache за окно 1750402800..1781938800: ${files.length}.`);
const full = rec.filter((r) => r.hours === FULL);
console.log(`Токенов с полным годом (${FULL} часов): ${full.length}. Короче года: ${rec.length - full.length}.`);
console.log(`Три фикстуры botLab (APT/BTC/ETH) - байт в байт копии трёх файлов отсюда.\n`);

console.log(`## 2 · Кросс-секция полного года: чистая ставка выбранной конфигурации\n`);
const mAPRs = full.map((r) => r.mAPR);
const netUsds = full.map((r) => r.netUsd);
console.log(`| величина | значение |`);
console.log(`|---|---|`);
console.log(`| токенов | ${full.length} |`);
console.log(`| среднее APR по токенам | ${f(mean(mAPRs))} |`);
console.log(`| медиана APR | ${f(median(mAPRs))} |`);
console.log(`| 10-й / 90-й перцентиль APR | ${f(q(mAPRs, 0.1))} / ${f(q(mAPRs, 0.9))} |`);
console.log(`| min / max APR | ${f(Math.min(...mAPRs))} / ${f(Math.max(...mAPRs))} |`);
console.log(`| доля токенов с нетто > 0 на $2000 | ${pct(fractionPositive(netUsds))} (${netUsds.filter((x) => x > 0).length} из ${full.length}) |`);
console.log(`| медиана нетто $ | ${f(median(netUsds), 2)} |`);
console.log(`| сумма нетто $ (равные веса) | ${f(netUsds.reduce((a, b) => a + b, 0), 2)} |`);

const sorted = full.slice().sort((a, b) => b.netUsd - a.netUsd);
console.log(`\nТоп-10 и дно-10 по нетто $ (двухногая, весь год, $2000, круг по DEFAULT_COSTS):\n`);
console.log(`| # | токен | конфиг | нетто $ | ср. APR | доля + часов | просадка $ | n_eff | ноль в полосе? |`);
console.log(`|---|---|---|---|---|---|---|---|---|`);
const show = (r, i) => {
  const b = r.chosen === "A" ? r.two.A : r.two.B;
  const inside = fin(r.band) ? Math.abs(r.mAPR) < r.band : null;
  console.log(`| ${i} | ${r.token} | ${r.chosen} | ${f(r.netUsd, 2)} | ${f(r.mAPR)} | ${pct(b.pctPos)} | ${f(r.dd * NOTIONAL, 2)} | ${f(r.ne, 1)} | ${inside === null ? "n/a" : inside ? "ДА" : "нет"} |`);
};
sorted.slice(0, 10).forEach((r, i) => show(r, i + 1));
console.log(`| ... | | | | | | | | |`);
sorted.slice(-10).forEach((r, i) => show(r, full.length - 9 + i));

// Где в этом ряду стоят три фикстуры
console.log(`\nМесто фикстур в ранжире из ${full.length}:`);
for (const t of ["APT", "BTC", "ETH"]) {
  const i = sorted.findIndex((r) => r.token === t);
  if (i >= 0) console.log(`  ${t}: место ${i + 1} из ${full.length}, нетто $${f(sorted[i].netUsd, 2)}, конфиг ${sorted[i].chosen}`);
}

// ── 3 · сколько независимых инструментов в кросс-секции
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  const xs = [], ys = [];
  for (let i = 0; i < n; i++) if (fin(a[i]) && fin(b[i])) { xs.push(a[i]); ys.push(b[i]); }
  if (xs.length < 3) return NaN;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { const u = xs[i] - mx, v = ys[i] - my; sxy += u * v; sxx += u * u; syy += v * v; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}
const daily = (s) => { const out = []; for (let i = 0; i + 24 <= s.length; i += 24) { let a = 0; for (let j = i; j < i + 24; j++) a += s[j] / HOURS_PER_YEAR; out.push(a); } return out; };
const dailySeries = full.map((r) => daily(r.netSeries));
const rs = [];
for (let i = 0; i < dailySeries.length; i++) for (let j = i + 1; j < dailySeries.length; j++) {
  const r = pearson(dailySeries[i], dailySeries[j]);
  if (fin(r)) rs.push(r);
}
const rBar = mean(rs);
const k = full.length;
const kEff = k / (1 + (k - 1) * rBar);
console.log(`\n## 3 · Сколько НЕЗАВИСИМЫХ инструментов в кросс-секции\n`);
console.log(`Пар: ${rs.length}. Корреляция суточных сумм чистой ставки:`);
console.log(`  средняя ${f(rBar, 3)}, медиана ${f(median(rs), 3)}, 10/90 перцентили ${f(q(rs, 0.1), 3)} / ${f(q(rs, 0.9), 3)}, max ${f(Math.max(...rs), 3)}`);
console.log(`k_eff = k / (1 + (k-1)·r) = ${k} / (1 + ${k - 1}·${f(rBar, 3)}) = ${f(kEff, 2)} независимых инструмента.`);
const seMean = sd(mAPRs) / Math.sqrt(kEff);
console.log(`Среднее APR по кросс-секции ${f(mean(mAPRs))} ± ${f(1.96 * seMean, 4)} (95%, знаменатель k_eff) -> ноль ${Math.abs(mean(mAPRs)) < 1.96 * seMean ? "ВНУТРИ" : "вне"} полосы.`);

// ── 4 · выбор конфигурации задним числом: сколько он даёт
console.log(`\n## 4 · Look-ahead в выборе конфигурации (scanTwoLeg берёт argmax среднего ПО ВСЕМУ окну)\n`);
const HALF = Math.floor(FULL / 2);
let agree = 0, oracleSum = 0, honestSum = 0, hindsightSum = 0;
const honest = [], hindsight = [];
for (const r of full) {
  const first = r.rows.slice(0, HALF);
  const second = r.rows.slice(HALF);
  const s1 = scanTwoLeg(first, { token: r.token });
  const s2 = scanTwoLeg(second, { token: r.token });
  if (s1.chosen === s2.chosen) agree += 1;
  const pick = s1.chosen; // выбор ТОЛЬКО по прошлому
  const outHonest = pnlPath(pick === "A" ? s2.seriesA : s2.seriesB, NOTIONAL).total;
  const outOracle = pnlPath(s2.chosen === "A" ? s2.seriesA : s2.seriesB, NOTIONAL).total;
  // выбор по всему году, применённый ко второй половине - именно так считался уже замеренный прогон
  const outHind = pnlPath(r.chosen === "A" ? s2.seriesA : s2.seriesB, NOTIONAL).total;
  honest.push(outHonest); hindsight.push(outHind);
  honestSum += outHonest; oracleSum += outOracle; hindsightSum += outHind;
}
console.log(`Половины по ${HALF} и ${FULL - HALF} часов. Совпал выбор A/B в двух половинах у ${agree} из ${full.length} токенов (${pct(agree / full.length)}).`);
console.log(`Брутто $ на второй половине, сумма по ${full.length} токенам ($2000 каждый):`);
console.log(`  выбор по прошлому (честно):        ${f(honestSum, 2)}`);
console.log(`  выбор по всему году (как замерено): ${f(hindsightSum, 2)}`);
console.log(`  оракул (лучшее задним числом):      ${f(oracleSum, 2)}`);
console.log(`Доля токенов с плюсом на второй половине: честно ${pct(fractionPositive(honest))}, задним числом ${pct(fractionPositive(hindsight))}.`);
console.log(`Медиана $: честно ${f(median(honest), 2)}, задним числом ${f(median(hindsight), 2)}.`);

// ── 5 · концентрация: год делают несколько часов?
console.log(`\n## 5 · Концентрация результата по часам (двухногая, выбранная конфигурация)\n`);
console.log(`| токен | брутто $ | доля от 10 лучших часов | от 1% лучших часов (88 ч) | от 1% худших |`);
console.log(`|---|---|---|---|---|`);
for (const t of ["APT", "BTC", "ETH", "HYPE", "PUMP"]) {
  const r = full.find((x) => x.token === t);
  if (!r) continue;
  const perHr = pnlPath(r.netSeries, NOTIONAL).perHr;
  const s = perHr.slice().sort((a, b) => b - a);
  const top10 = s.slice(0, 10).reduce((a, b) => a + b, 0);
  const top1p = s.slice(0, 88).reduce((a, b) => a + b, 0);
  const bot1p = s.slice(-88).reduce((a, b) => a + b, 0);
  console.log(`| ${t} | ${f(r.gross, 2)} | ${f(top10 / r.gross * 100, 1)}% | ${f(top1p / r.gross * 100, 1)}% | ${f(bot1p / r.gross * 100, 1)}% |`);
}

// ── 6 · сколько токенов вообще ТОРГУЕМЫ живым ботом
console.log(`\n## 6 · Разрыв между корпусом и живой вселенной\n`);
console.log(`universe.js бота 1: two-leg = ETH, BTC; one-leg = ETH-Arb, BTC-Arb, ETH-Avax. APT удалён 2026-07-02 (мёртвый рынок GMX).`);
const tradable = full.filter((r) => ["ETH", "BTC"].includes(r.token));
console.log(`Токенов корпуса, попавших в живую вселенную: ${tradable.length} из ${full.length}.`);
for (const r of tradable) {
  const inside = fin(r.band) ? Math.abs(r.mAPR) < r.band : null;
  console.log(`  ${r.token}: конфиг ${r.chosen}, нетто $${f(r.netUsd, 2)}, APR ${f(r.mAPR)} ± ${f(r.band)}, ноль ${inside ? "ВНУТРИ полосы" : "вне полосы"}`);
}
