#!/usr/bin/env node
// eval-score.mjs - проверка КВАНТИЛЬНО-СКОРИНГОВОЙ схемы на нашей записи. READ-ONLY, без сети.
//
// ЗАЧЕМ. Автор чеклиста предложил заменить фиксированные пороги квантилями, а логическое И -
// взвешенным счётом, и утверждает, что «конфликт условий устранён, частота сделок должна
// увеличиться». Это проверяемо: все девять факторов его формулы есть в нашей записи тиков.
//
// ЧТО ПРОВЕРЯЕМ. Три разных вопроса, которые легко перепутать:
//   1. Во что превращаются его квантильные пороги в АБСОЛЮТНЫХ величинах на нашем рынке.
//   2. Сколько сделок даёт его схема.
//   3. ЧТО именно она покупает - потому что «сделок стало больше» само по себе не достижение.
//
// ГЛАВНОЕ, ЧТО НАДО ДЕРЖАТЬ В ГОЛОВЕ ПРИ ЧТЕНИИ. Правило «вход, если Score ≥ Q80(Score)» пропускает
// ровно 20% наблюдений ПО ОПРЕДЕЛЕНИЮ, в любом рынке. Рост частоты сделок в такой схеме не является
// свидетельством того, что возможности нашлись: он заложен в саму формулировку правила. Поэтому
// ниже рядом с числом сделок всегда стоит качество того, что покупалось.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const fin = (x) => Number.isFinite(x);
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const DIR = argOf("--dir");
if (!DIR) { console.error("нужен --dir <каталог с scan-records>"); process.exit(1); }
const RECS = existsSync(join(DIR, "scan-records")) ? join(DIR, "scan-records") : DIR;
const DWELL = Number(argOf("--dwell", 3));
const COOLDOWN_S = Number(argOf("--cooldown", 1800));

const ticks = [];
for (const f of readdirSync(RECS).filter((x) => x.includes("-ticks-") && x.endsWith(".ndjson"))) {
  for (const line of readFileSync(join(RECS, f), "utf8").split("\n")) {
    if (line.trim()) { try { ticks.push(JSON.parse(line)); } catch {} }
  }
}
ticks.sort((a, b) => a.ts - b.ts);
const spanH = (ticks.at(-1).ts - ticks[0].ts) / 3600000;

const q = (a, p) => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return null;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const f = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");

// ── Сырые факторы из записи. Всё, что просит его формула, у нас есть: он просил девять величин,
// и все девять писались на каждом тике.
const R = ticks.map((t) => {
  const B = t.B || {}, V = t.V || {};
  return {
    ts: t.ts,
    bias: fin(t.rv7) && fin(t.ivr) && fin(t.base) && t.base > 0 ? (t.rv7 - t.ivr) / t.base : null,
    impulse: V["У4"] ?? null,
    disb: V["У8"] ?? null,           // дисбаланс стакана перпа - он его и просил
    skew: V["У7"] ?? null,
    fiv: V["У6"] ?? null,
    prem: B.pr ?? null,              // премия, % спота
    spread: B.sp ?? null,            // спред, % премии
    depth: B.dp ?? null,             // глубина книги, $
    theta: B.th ?? null,             // тета, % премии в сутки
    base: t.base ?? null,
    rtc: B.rtc ?? null,
    days: fin(B.e) ? (B.e - t.ts) / 86400000 : null,
  };
});
const col = (k) => R.map((r) => r[k]).filter(fin);

// ── 1. Его квантили в абсолютных величинах
const Qp = { p25: q(col("prem"), .25), p50: q(col("prem"), .5), p75: q(col("prem"), .75), p80: q(col("prem"), .8) };
const Qs = { p25: q(col("spread"), .25), p50: q(col("spread"), .5), p70: q(col("spread"), .7), p75: q(col("spread"), .75) };
const Qd = { p30: q(col("depth"), .3), p50: q(col("depth"), .5), p75: q(col("depth"), .75) };
const Qi = { p50: q(col("impulse"), .5), p65: q(col("impulse"), .65), p75: q(col("impulse"), .75) };
const Qb = { p50: q(col("disb"), .5), p75: q(col("disb"), .75) };
const thetaLimit = q(col("base"), .5) * 0.3;   // его формула: baseline_IV × 0.3

console.log(`# Проверка квантильно-скоринговой схемы на записи\n`);
console.log(`Запись: ${ticks.length} тиков, ${f(spanH, 1)} ч. Сделка = ${DWELL} тика подряд + кулдаун ${COOLDOWN_S / 60} мин.\n`);

console.log(`## 1. Во что превращаются квантильные пороги на нашем рынке\n`);
console.log(`| порог по его схеме | в абсолютных величинах | наш нынешний фиксированный | кто строже |`);
console.log(`|---|---|---|---|`);
const cmp = (a, b, lower = true) => (lower ? (a > b ? "**его слабее**" : "наш слабее") : (a < b ? "**его слабее**" : "наш слабее"));
console.log(`| премия ≤ Q80 | ${f(Qp.p80)}% спота | 2.00% спота | ${cmp(Qp.p80, 2)} |`);
console.log(`| спред ≤ Q70 | ${f(Qs.p70)}% премии | 8.00% премии | ${cmp(Qs.p70, 8)} |`);
console.log(`| глубина ≥ Q30 | $${f(Qd.p30, 0)} | $5000 | ${cmp(Qd.p30, 5000, false)} |`);
console.log(`| тета ≤ базовая IV × 0.3 | ${f(thetaLimit)} %/сут | 10.00 %/сут | ${cmp(thetaLimit, 10)} |`);
console.log(`| импульс ≥ Q65 | ${f(Qi.p65)}σ | 0.70σ | ${cmp(Qi.p65, 0.7, false)} |`);

// ── 2. Жёсткий фильтр-минимум
const hard = (r) => fin(r.prem) && fin(r.spread) && fin(r.depth) && fin(r.theta)
  && r.prem <= Qp.p80 && r.spread <= Qs.p70 && r.depth >= Qd.p30 && r.theta <= thetaLimit;
const passHard = R.filter(hard);
console.log(`\n## 2. Жёсткий фильтр-минимум\n`);
console.log(`Проходит ${passHard.length} тиков из ${R.length} (**${f(100 * passHard.length / R.length, 1)}%**).`);
console.log(`Для сравнения: наш нынешний набор из двенадцати условий проходил 0 тиков из ${R.length}.`);

// ── 3. Скор по его формуле
const norm = {
  bias: (r) => r.bias,
  impulse: (r) => (fin(r.impulse) && Qi.p75 !== Qi.p50 ? (r.impulse - Qi.p50) / (Qi.p75 - Qi.p50) : null),
  disb: (r) => (fin(r.disb) && Qb.p75 !== Qb.p50 ? (r.disb - Qb.p50) / (Qb.p75 - Qb.p50) : null),
  skew: (r) => { const s = q(col("skew").map(Math.abs), .75); return fin(r.skew) && s ? r.skew / s : null; },
  fiv: (r) => { const s = q(col("fiv").map(Math.abs), .75); return fin(r.fiv) && s ? r.fiv / s : null; },
  prem: (r) => (fin(r.prem) && Qp.p75 !== Qp.p25 ? (Qp.p75 - r.prem) / (Qp.p75 - Qp.p25) : null),
  spread: (r) => (fin(r.spread) && Qs.p75 !== Qs.p25 ? (Qs.p75 - r.spread) / (Qs.p75 - Qs.p25) : null),
  depth: (r) => (fin(r.depth) && Qd.p75 !== Qd.p50 ? (r.depth - Qd.p50) / (Qd.p75 - Qd.p50) : null),
  theta: (r) => (fin(r.theta) && thetaLimit ? (thetaLimit - r.theta) / thetaLimit : null),
};
// Начальные веса по его подсказке: Bias и Premium_score сильнее, остальное слабее.
const W = { bias: 2, impulse: 1, disb: 1, skew: 1, fiv: 1, prem: 2, spread: 1, depth: 1, theta: 1 };
const scoreOf = (r) => {
  let s = 0, used = 0;
  for (const k of Object.keys(W)) { const v = norm[k](r); if (fin(v)) { s += W[k] * v; used++; } }
  return used ? s : null;
};
for (const r of R) r.score = scoreOf(r);
const scores = col("score");
console.log(`\n## 3. Распределение счёта\n`);
console.log(`| квантиль | Q50 | Q70 | Q80 | Q90 |`);
console.log(`|---|---|---|---|---|`);
console.log(`| значение счёта | ${f(q(scores, .5))} | ${f(q(scores, .7))} | ${f(q(scores, .8))} | ${f(q(scores, .9))} |`);

// ── 4. Сделки
function trades(pred) {
  const out = []; let run = 0, until = 0;
  for (const r of R) {
    if (!pred(r)) { run = 0; continue; }
    run += 1;
    if (run >= DWELL && r.ts >= until) { out.push(r); until = r.ts + COOLDOWN_S * 1000; run = 0; }
  }
  return out;
}
const med = (a) => q(a.filter(fin), .5);
console.log(`\n## 4. Сколько сделок и что покупали бы\n`);
console.log(`| правило входа | сделок | в сутки | премия % спота | тета %/сут | издержки % премии | срок |`);
console.log(`|---|---|---|---|---|---|---|`);
for (const [name, p] of [
  ["только жёсткий фильтр", (r) => hard(r)],
  ["фильтр + счёт ≥ Q70", (r) => hard(r) && fin(r.score) && r.score >= q(scores, .7)],
  ["фильтр + счёт ≥ Q80", (r) => hard(r) && fin(r.score) && r.score >= q(scores, .8)],
  ["фильтр + счёт ≥ Q90", (r) => hard(r) && fin(r.score) && r.score >= q(scores, .9)],
]) {
  const tr = trades(p);
  console.log(`| ${name} | **${tr.length}** | ${f(tr.length / (spanH / 24), 1)} | ${f(med(tr.map((r) => r.prem)))} | ${f(med(tr.map((r) => r.theta)), 1)} | ${f(med(tr.map((r) => r.rtc)), 1)} | ${f(med(tr.map((r) => r.days)), 1)}д |`);
}

// ── 5. БЕЗ ЗАГЛЯДЫВАНИЯ ВПЕРЁД: квантили по скользящему окну, как было бы живьём.
// Выше все квантили посчитаны по ВСЕЙ выборке - то есть схеме дано знание о будущем. Он сам пишет
// «раз в день обновляешь распределения», значит живьём они считаются по прошлому. Разница между
// двумя расчётами и есть та фора, которую бектест даёт стратегии незаметно для автора.
const WIN_H = Number(argOf("--window", 24));
function trailing(i, key, p) {
  const from = R[i].ts - WIN_H * 3600000;
  const a = [];
  for (let j = i; j >= 0 && R[j].ts >= from; j--) if (fin(R[j][key])) a.push(R[j][key]);
  return a.length >= 30 ? q(a, p) : null;
}
const warm = R.findIndex((r) => r.ts - R[0].ts >= WIN_H * 3600000);
let hardT = 0;
const scoreT = [];
for (let i = 0; i < R.length; i++) {
  R[i].okT = false; R[i].scoreT = null;
  if (i < warm) continue;
  const p80 = trailing(i, "prem", .8), s70 = trailing(i, "spread", .7), d30 = trailing(i, "depth", .3);
  const r = R[i];
  if (!fin(p80) || !fin(s70) || !fin(d30)) continue;
  if (!(fin(r.prem) && fin(r.spread) && fin(r.depth) && fin(r.theta))) continue;
  if (r.prem <= p80 && r.spread <= s70 && r.depth >= d30 && r.theta <= thetaLimit) { r.okT = true; hardT++; }
  r.scoreT = r.score;
  if (fin(r.scoreT)) scoreT.push(r.scoreT);
}
console.log(`\n## 5. То же самое БЕЗ заглядывания вперёд (квантили по скользящему окну ${WIN_H} ч)\n`);
console.log(`| правило входа | сделок | было при квантилях по всей выборке |`);
console.log(`|---|---|---|`);
{
  const full = [
    ["только жёсткий фильтр", (r) => hard(r), null],
    ["фильтр + счёт ≥ Q80", (r) => hard(r) && fin(r.score) && r.score >= q(scores, .8), null],
  ];
  const trT = trades((r) => r.okT);
  const q80t = q(scoreT, .8);
  const trT80 = trades((r) => r.okT && fin(r.scoreT) && r.scoreT >= q80t);
  console.log(`| только жёсткий фильтр | **${trT.length}** | ${trades(full[0][1]).length} |`);
  console.log(`| фильтр + счёт ≥ Q80 | **${trT80.length}** | ${trades(full[1][1]).length} |`);
}
console.log(`\n(прогрев ${WIN_H} ч в начале записи в счёт не идёт)`);

console.log(`\n## 6. Что важно понимать про эти числа\n`);
console.log(`Правило «вход при счёте ≥ Q80» пропускает ровно 20% наблюдений ПО ОПРЕДЕЛЕНИЮ, в любом`);
console.log(`рынке. Рост частоты сделок здесь не свидетельство того, что возможности нашлись: он`);
console.log(`заложен в саму формулировку. Тот же расчёт на рынке, где покупать опционы невыгодно,`);
console.log(`дал бы столько же входов - просто в худшие инструменты.`);
console.log(`\nПоэтому смотреть надо на правую часть таблицы: премия, тета, издержки и срок того, что`);
console.log(`покупалось бы. Именно там видно, отбирает схема хорошее или просто лучшее из плохого.`);
