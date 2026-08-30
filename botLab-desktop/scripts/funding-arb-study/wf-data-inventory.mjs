import { APP as STUDY_APP } from "./paths.mjs";
// wf-data-inventory.mjs - инвентарь данных бота 1. Только чтение, в репозиторий не пишет.
//
// Все правила зовутся из движка: parseSpreadCsv, annualizeRow, scanTwoLeg, scanOneLeg,
// maxDrawdownFraction, pnlPath, DEFAULT_COSTS, roundTripCost, а размер выборки - acf/nEff/ci95
// из src/engine/otmscan/stats.js. Свои здесь только описательные сводки (счётчики дыр, диапазоны
// столбцов, кросс-корреляция между токенами), правил начисления они не дублируют.

import { readFileSync } from "node:fs";
import { parseSpreadCsv } from "../../src/engine/format.js";
import {
  scanTwoLeg,
  scanOneLeg,
  annualizeRow,
  maxDrawdownFraction,
  pnlPath,
  mean,
  median,
  std,
  minOf,
  maxOf,
  fractionPositive,
  signChanges,
  HOURS_PER_YEAR,
} from "../../src/engine/math.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";
import { acf, nEff, ci95, sd } from "../../src/engine/otmscan/stats.js";

const FIX = STUDY_APP+"/test/fixtures";
const TOKENS = ["APT", "BTC", "ETH"];
const CAPITAL = 2000;
const LEVERAGE = 1;
const fin = (x) => Number.isFinite(x);
const f = (x, d = 4) => (fin(x) ? x.toFixed(d) : "n/a");
const pct = (x, d = 2) => (fin(x) ? (x * 100).toFixed(d) + "%" : "n/a");

// ── 1 · сырьё: что вообще лежит в фикстурах
const data = {};
console.log("## 1 · Фикстуры: форма и полнота\n");
console.log("| файл | байт | строк (parseSpreadCsv) | первый час | последний час | часов по календарю | дыр | дублей ts |");
console.log("|---|---|---|---|---|---|---|---|");
for (const t of TOKENS) {
  const path = `${FIX}/${t}.csv`;
  const text = readFileSync(path, "utf8");
  const rows = parseSpreadCsv(text);
  const hours = rows.map((r) => r.tsHour);
  const span = (hours[hours.length - 1] - hours[0]) / 3600 + 1;
  const uniq = new Set(hours);
  let gaps = 0;
  for (let i = 1; i < hours.length; i++) if (hours[i] - hours[i - 1] !== 3600) gaps += 1;
  data[t] = { rows, path, bytes: text.length };
  console.log(
    `| ${t}.csv | ${text.length} | ${rows.length} | ${rows[0].ts} | ${rows[rows.length - 1].ts} | ${span} | ${gaps} | ${rows.length - uniq.size} |`,
  );
}

// одинаковы ли сетки времени у трёх файлов
const gridSame = TOKENS.every((t) => data[t].rows.length === data.APT.rows.length &&
  data[t].rows.every((r, i) => r.tsHour === data.APT.rows[i].tsHour));
console.log(`\nСетка часов у трёх файлов ${gridSame ? "СОВПАДАЕТ поэлементно" : "РАЗЛИЧАЕТСЯ"}.`);

// ── 2 · распределение сырых столбцов
console.log("\n## 2 · Сырые столбцы (как пришли из Subsquid / Hyperliquid)\n");
const COLS = ["f_long", "f_short", "b_long", "b_short", "hl_rate", "hl_premium"];
console.log("| токен | столбец | NaN | нулей | min | медиана | среднее | max | доля > 0 |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const t of TOKENS) {
  for (const c of COLS) {
    const xs = data[t].rows.map((r) => r[c]);
    const nan = xs.filter((x) => !fin(x)).length;
    const zero = xs.filter((x) => x === 0).length;
    console.log(
      `| ${t} | ${c} | ${nan} | ${zero} | ${minOf(xs).toExponential(3)} | ${median(xs).toExponential(3)} | ${mean(xs).toExponential(3)} | ${maxOf(xs).toExponential(3)} | ${pct(fractionPositive(xs), 1)} |`,
    );
  }
}

// ── 3 · чистая ставка по движку: scanTwoLeg (A и B) и scanOneLeg
console.log("\n## 3 · Чистая ставка через annualizeRow (годовые доли, весь год)\n");
console.log("| токен | конфигурация | часов | среднее APR | медиана APR | сигма | min | max | доля + часов | смен знака | худшая просадка |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
const series = {}; // ключ "APT/two-A" -> часовой ряд net APR
const scans = {};
for (const t of TOKENS) {
  const rows = data[t].rows;
  const two = scanTwoLeg(rows, { token: t });
  const one = scanOneLeg(rows, { token: t });
  scans[t] = { two, one };
  for (const cfg of ["A", "B"]) {
    const b = two[cfg];
    series[`${t}/two-${cfg}`] = b._net;
    console.log(
      `| ${t} | two-${cfg}${two.chosen === cfg ? " (выбор scanTwoLeg)" : ""} | ${two.hours} | ${f(b.netMean)} | ${f(b.netMedian)} | ${f(b.netStd)} | ${f(b.netMin)} | ${f(b.netMax)} | ${pct(b.pctPos, 1)} | ${b.signChg} | ${pct(b.ddPct, 3)} |`,
    );
  }
  series[`${t}/one`] = one.net;
  console.log(
    `| ${t} | one | ${one.hours} | ${f(one.netMean)} | ${f(one.netMedian)} | ${f(std(one.net))} | ${f(one.netMin)} | ${f(one.netMax)} | ${pct(one.pctPos, 1)} | ${one.flips} | ${pct(one.ddPct, 3)} |`,
  );
}

// сверка с уже замеренным: брутто $ на $2000 через pnlPath, нетто через roundTripCost
console.log("\n## 4 · Сверка с уже замеренным (pnlPath на $2000, круг по DEFAULT_COSTS)\n");
console.log("| позиция | брутто $ | круг $ | нетто $ | просадка $ (maxDrawdownFraction) |");
console.log("|---|---|---|---|---|");
const notional = CAPITAL * LEVERAGE;
for (const t of TOKENS) {
  for (const key of [`${t}/two-A`, `${t}/two-B`, `${t}/one`]) {
    const isOne = key.endsWith("/one");
    const p = pnlPath(series[key], notional);
    const rt = roundTripCost(DEFAULT_COSTS, notional, isOne);
    const dd = maxDrawdownFraction(series[key]) * notional;
    console.log(`| ${key} | ${p.total.toFixed(2)} | ${rt.toFixed(2)} | ${(p.total - rt).toFixed(2)} | ${dd.toFixed(2)} |`);
  }
}

// ── 5 · сколько независимых наблюдений содержит год
console.log("\n## 5 · Размер выборки: n_eff по stats.js (nEff = n / (1 + 2·Σ ρ_k))\n");
console.log("| ряд | часов | ρ(1ч) | ρ(24ч) | ρ(168ч) | n_eff | часов на одно независимое | среднее APR | ±95% по n_eff | ноль внутри полосы? |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
const effRows = [];
for (const key of Object.keys(series)) {
  const s = series[key];
  const ne = nEff(s);
  const band = ci95(s);
  const m = mean(s);
  const inside = fin(band) ? Math.abs(m) < band : null;
  effRows.push({ key, ne, m, band, inside });
  console.log(
    `| ${key} | ${s.length} | ${f(acf(s, 1), 3)} | ${f(acf(s, 24), 3)} | ${f(acf(s, 168), 3)} | ${f(ne, 1)} | ${f(s.length / ne, 0)} | ${f(m, 4)} | ${f(band, 4)} | ${inside === null ? "n/a" : inside ? "ДА (от нуля не отличить)" : "нет"} |`,
  );
}

// ── 6 · сколько независимых ИНСТРУМЕНТОВ, а не часов
// Кросс-корреляция часовых рядов чистой ставки. Формула эффективного числа для k рядов со
// средней попарной корреляцией r: k_eff = k / (1 + (k-1)·r).
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  const xs = [], ys = [];
  for (let i = 0; i < n; i++) if (fin(a[i]) && fin(b[i])) { xs.push(a[i]); ys.push(b[i]); }
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const u = xs[i] - mx, v = ys[i] - my;
    sxy += u * v; sxx += u * u; syy += v * v;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

console.log("\n## 6 · Сколько независимых ИНСТРУМЕНТОВ (кросс-корреляция часовых net APR)\n");
const chosenKeys = TOKENS.map((t) => `${t}/two-${scans[t].two.chosen}`);
console.log("Выбор scanTwoLeg на полной выборке: " + chosenKeys.join(", ") + "\n");
console.log("| пара | корреляция часовых net APR | корреляция суточных сумм |");
console.log("|---|---|---|");
const daily = (s) => {
  const out = [];
  for (let i = 0; i + 24 <= s.length; i += 24) {
    let acc = 0;
    for (let j = i; j < i + 24; j++) acc += s[j] / HOURS_PER_YEAR;
    out.push(acc);
  }
  return out;
};
let sumR = 0, nPairs = 0, sumRd = 0;
for (let i = 0; i < chosenKeys.length; i++) {
  for (let j = i + 1; j < chosenKeys.length; j++) {
    const r = pearson(series[chosenKeys[i]], series[chosenKeys[j]]);
    const rd = pearson(daily(series[chosenKeys[i]]), daily(series[chosenKeys[j]]));
    sumR += r; sumRd += rd; nPairs += 1;
    console.log(`| ${chosenKeys[i]} vs ${chosenKeys[j]} | ${f(r, 3)} | ${f(rd, 3)} |`);
  }
}
const rBar = sumR / nPairs;
const rBarD = sumRd / nPairs;
const kEff = (k, r) => k / (1 + (k - 1) * r);
console.log(`\nСредняя попарная корреляция (часовая): ${f(rBar, 3)}; k_eff = 3 / (1 + 2·r) = ${f(kEff(3, rBar), 2)} инструмента.`);
console.log(`Средняя попарная корреляция (суточная): ${f(rBarD, 3)}; k_eff = ${f(kEff(3, rBarD), 2)} инструмента.`);

// одноногие: ETH-Arb и BTC-Arb это те же f_short/b_short, что и в двухногой A
console.log("\n## 7 · Перекрытие одноногих с двухногими (тот же источник GMX)\n");
console.log("| токен | corr(one, two-A) | corr(one, two-B) |");
console.log("|---|---|---|");
for (const t of TOKENS) {
  console.log(`| ${t} | ${f(pearson(series[`${t}/one`], series[`${t}/two-A`]), 3)} | ${f(pearson(series[`${t}/one`], series[`${t}/two-B`]), 3)} |`);
}

// ── 8 · итоговый счётчик доказуемости
console.log("\n## 8 · Потолок доказуемости\n");
const yrs = (data.APT.rows.length / HOURS_PER_YEAR).toFixed(3);
console.log(`Календарь: ${yrs} года, ${data.APT.rows.length} часов, ${TOKENS.length} токена, 9 позиций (3 токена x {two-A, two-B, one}).`);
const neOfChosen = chosenKeys.map((k) => nEff(series[k]));
console.log(`n_eff выбранных конфигураций: ${neOfChosen.map((x) => f(x, 1)).join(", ")}; сумма ${f(neOfChosen.reduce((a, b) => a + b, 0), 1)}.`);
console.log(`Поправка на кросс-корреляцию: сумма x k_eff/3 = ${f(neOfChosen.reduce((a, b) => a + b, 0) * kEff(3, rBar) / 3, 1)} независимых наблюдений на весь корпус.`);
for (const r of effRows) {
  if (chosenKeys.includes(r.key)) {
    console.log(`  ${r.key}: среднее ${f(r.m, 4)} ± ${f(r.band, 4)} (95% по n_eff) -> ${r.inside ? "НОЛЬ ВНУТРИ ПОЛОСЫ" : "ноль вне полосы"}`);
  }
}
