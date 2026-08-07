#!/usr/bin/env node
// eval-toll.mjs — две величины, от которых зависит, имеет ли покупка опционов смысл в принципе.
// READ-ONLY, без сети. Читает ту же запись, что report:records и eval:buy.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ. Все прежние отчёты меряли издержки в ПРОЦЕНТАХ ПРЕМИИ, а преимущество
// стратегии (У1, У2) в ПУНКТАХ ВОЛАТИЛЬНОСТИ. Пока эти две величины живут в разных единицах, их
// нельзя положить рядом и увидеть, покрывает ли одна другую. Здесь они приводятся к одной шкале:
//
//   круг издержек в пунктах IV = (комиссия обеих сторон + спред) / вега
//
// Смысл: на столько пунктов подразумеваемая волатильность обязана оказаться заниженной, чтобы
// сделка вышла в ноль ДО учёта тэты и движения цены. Это порог, ниже которого никакая калибровка
// порогов, никакое правило выхода и никакая параллельность позиций не помогают.
//
// ВТОРАЯ ВЕЛИЧИНА — сколько независимых наблюдений вообще содержит запись. Доходности покупок,
// открытых с разницей в полчаса, совпадают на 90%: это одно наблюдение, записанное дважды. Без
// поправки на это любая доля прибыльных сделок читается как результат, хотя она внутри шума.
// Считается автокорреляцией доходности по лагу, знаменатель ошибки — n_eff, а не число строк.
//
// ЧЕГО СКРИПТ НЕ ДЕЛАЕТ: не выбирает пороги, не рекомендует пресет и не считает доходность
// стратегии. Он отвечает на два вопроса, которые предшествуют всем остальным.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { OPTION_FEE_RATE, OPTION_FEE_CAP_PCT_PREMIUM } from "../src/engine/otmscan/presets.js";

const fin = (x) => Number.isFinite(x);
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const DIR = argOf("--dir");
if (!DIR) { console.error("нужен --dir <каталог с scan-records>"); process.exit(1); }
const RECS = existsSync(join(DIR, "scan-records")) ? join(DIR, "scan-records") : DIR;
const STEP = Number(argOf("--step", 8)); // прореживание снимков для таблицы издержек

const load = (kind) => {
  const out = [];
  for (const f of readdirSync(RECS).filter((x) => x.includes(`-${kind}-`) && x.endsWith(".ndjson")).sort()) {
    for (const line of readFileSync(join(RECS, f), "utf8").split("\n")) {
      if (line.trim()) { try { out.push(JSON.parse(line)); } catch {} }
    }
  }
  return out;
};

const snaps = new Map();
for (const r of load("surface")) {
  let m = snaps.get(r.ts);
  if (!m) { m = new Map(); snaps.set(r.ts, m); }
  m.set(r.n, r);
}
const times = [...snaps.keys()].sort((a, b) => a - b);
if (times.length < 10) { console.error("в записи нет снимков поверхности"); process.exit(1); }

const feeUsd = (mark, index) => Math.min(OPTION_FEE_RATE * index, (OPTION_FEE_CAP_PCT_PREMIUM / 100) * mark);
const q = (a, p) => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return null;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const f = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");

console.log(`# Цена круга в пунктах волатильности и размер выборки\n`);
console.log(`Запись: ${times.length} снимков поверхности, ${f((times.at(-1) - times[0]) / 3600000, 1)} ч.`);
console.log(`Комиссия ${OPTION_FEE_RATE} от индекса за сторону, кэп ${OPTION_FEE_CAP_PCT_PREMIUM}% премии (пресетные константы).\n`);

// ── 1 · круг издержек в пунктах IV по сроку и дельте
const EXP_B = [[2, 4], [4, 8], [8, 16], [16, 32], [32, 64], [64, 1e9]];
const DEL_B = [[0.2, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6]];
const cell = new Map();
for (let i = 0; i < times.length; i += Math.max(1, STEP)) {
  for (const r of snaps.get(times[i]).values()) {
    if (!fin(r.m) || r.m <= 0 || !fin(r.b) || !fin(r.a) || r.a < r.b) continue;
    if (!fin(r.vg) || r.vg <= 0 || !fin(r.d) || !fin(r.th) || !fin(r.h) || !fin(r.f)) continue;
    const days = r.h / 24, ad = Math.abs(r.d);
    const e = EXP_B.findIndex(([lo, hi]) => days >= lo && days < hi);
    const d = DEL_B.findIndex(([lo, hi]) => ad >= lo && ad < hi);
    if (e < 0 || d < 0) continue;
    const fee = feeUsd(r.m, r.f), half = (r.a - r.b) / 2;
    const key = `${e}|${d}`;
    let arr = cell.get(key);
    if (!arr) { arr = []; cell.set(key, arr); }
    // maker-mid: вход по середине, выход пересечением (выходы триггерные — тейкерские по природе)
    arr.push({ ivPts: (2 * fee + half) / r.vg, pctPrem: ((2 * fee + half) / r.m) * 100,
      feeShare: ((2 * fee) / (2 * fee + half)) * 100, theta: (Math.abs(r.th) / r.m) * 100,
      prem: (r.m / r.f) * 100, spread: ((r.a - r.b) / r.m) * 100 });
  }
}
const lbl = (b) => `${b[0]}-${b[1] === 1e9 ? "беск." : b[1]} дн`;
console.log(`## 1 · Круг издержек в ПУНКТАХ IV (исполнение maker-mid)\n`);
console.log(`Столько пунктов подразумеваемой волатильности сделка обязана отыграть, чтобы выйти`);
console.log(`в ноль до тэты и до движения цены.\n`);
console.log(`| срок \\ дельта | ${DEL_B.map((d) => `${d[0]}-${d[1]}`).join(" | ")} |`);
console.log(`|---|${DEL_B.map(() => "---").join("|")}|`);
for (let e = 0; e < EXP_B.length; e++) {
  const row = DEL_B.map((_, d) => { const a = cell.get(`${e}|${d}`); return a && a.length > 30 ? f(q(a.map((x) => x.ivPts), .5), 2) : "·"; });
  console.log(`| **${lbl(EXP_B[e])}** | ${row.join(" | ")} |`);
}
console.log(`\nКомиссия равна 0.0003 индекса за сторону, то есть в долларах ОДИНАКОВА для любого`);
console.log(`опциона; в пункты волатильности её переводит вега, а вега растёт как корень из срока.`);
console.log(`Отсюда падение цифр сверху вниз: это не свойство рынка, а арифметика тарифа.\n`);

console.log(`## 2 · Тот же срез подробно, полоса дельты 0.4-0.5\n`);
console.log(`| срок | n | круг, пунктов IV | круг, % премии | доля комиссии в круге | тета, %/сут | премия, % спота | спред, % премии |`);
console.log(`|---|---|---|---|---|---|---|---|`);
for (let e = 0; e < EXP_B.length; e++) {
  const a = cell.get(`${e}|2`);
  if (!a || a.length < 30) continue;
  console.log(`| ${lbl(EXP_B[e])} | ${a.length} | **${f(q(a.map((x) => x.ivPts), .5), 2)}** | ${f(q(a.map((x) => x.pctPrem), .5), 1)}% | ${f(q(a.map((x) => x.feeShare), .5), 0)}% | ${f(q(a.map((x) => x.theta), .5), 1)} | ${f(q(a.map((x) => x.prem), .5), 2)}% | ${f(q(a.map((x) => x.spread), .5), 1)}% |`);
}

// ── 3 · сколько независимых наблюдений в записи
const fwd = times.map((ts) => { for (const r of snaps.get(ts).values()) if (fin(r.f)) return r.f; return null; });
const ticks = load("ticks").sort((a, b) => a.ts - b.ts);
const tickAt = (x) => { let lo = 0, hi = ticks.length - 1, res = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ticks[m].ts <= x) { res = m; lo = m + 1; } else hi = m - 1; } return ticks[res]; };

// доходность покупки ближайшего к деньгам опциона стороны тика с удержанием H часов
function series(H) {
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const t = ticks.length ? tickAt(times[i]) : null;
    const side = t?.sd === "put" ? "P" : "C";
    const spot = fwd[i];
    if (!fin(spot)) continue;
    let best = null;
    for (const r of snaps.get(times[i]).values()) {
      if (r.s !== side || !fin(r.d) || !fin(r.m) || r.m <= 0 || !fin(r.b) || !fin(r.a)) continue;
      if (!fin(r.h) || r.h < 48 || r.h > 336) continue;
      const s = Math.abs(Math.abs(r.d) - 0.45);
      if (s > 0.1) continue;
      if (!best || s < best.s) best = { r, s };
    }
    if (!best) continue;
    const r0 = best.r;
    const tgt = times[i] + H * 3600000;
    let j = i + 1;
    while (j < times.length && times[j] < tgt) j++;
    if (j >= times.length) break;
    const r1 = snaps.get(times[j])?.get(r0.n);
    if (!r1 || !fin(r1.m) || !fin(r1.b)) continue;
    const paid = r0.a * 0.01 + feeUsd(r0.m, r0.f) * 0.01;
    out.push((((r1.b * 0.01 - feeUsd(r1.m, r1.f) * 0.01) - paid) / paid) * 100);
  }
  return out;
}
const acf = (xs, lag) => {
  const n = xs.length - lag;
  if (n < 10) return null;
  const a = xs.slice(0, n), b = xs.slice(lag);
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const u = a[i] - ma, v = b[i] - mb; sab += u * v; saa += u * u; sbb += v * v; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
};
const stepMin = (times[1] - times[0]) / 60000 || 5;

console.log(`\n## 3 · Сколько независимых наблюдений содержит запись\n`);
console.log(`Покупки, открытые близко по времени, это ОДНО наблюдение, записанное несколько раз.`);
console.log(`Меряем автокорреляцию доходности по лагу; шаг ряда ${f(stepMin, 0)} мин.\n`);
console.log(`| удержание | наблюдений | корр. на 0.5 ч | 2 ч | 6 ч | 12 ч | **n_eff** | часов на одно независимое |`);
console.log(`|---|---|---|---|---|---|---|---|`);
const spanH = (times.at(-1) - times[0]) / 3600000;
const effs = [];
for (const H of [8, 12, 24]) {
  const xs = series(H);
  if (xs.length < 50) continue;
  const at = (h) => { const c = acf(xs, Math.round((h * 60) / stepMin)); return c == null ? "н/д" : f(c, 2); };
  let sum = 0;
  for (let k = 1; k < xs.length; k++) { const c = acf(xs, k); if (c == null || c <= 0) break; sum += (1 - k / xs.length) * c; }
  const nEff = xs.length / (1 + 2 * sum);
  effs.push({ H, nEff });
  console.log(`| ${H} ч | ${xs.length} | ${at(0.5)} | ${at(2)} | ${at(6)} | ${at(12)} | **${f(nEff, 1)}** | ${f(spanH / nEff, 1)} ч |`);
}

console.log(`\n## 4 · Сколько записи нужно на заданное число независимых наблюдений\n`);
console.log(`| удержание | на 10 независимых | на 30 | на 100 |`);
console.log(`|---|---|---|---|`);
for (const { H, nEff } of effs) {
  const per = spanH / nEff;
  console.log(`| ${H} ч | ${f((per * 10) / 24, 1)} сут | ${f((per * 30) / 24, 1)} сут | ${f((per * 100) / 24, 0)} сут |`);
}
console.log(`\nЭто оценка СВЕРХУ по скорости: она считает, что позиция открыта всегда. Правило входа,`);
console.log(`которое держит нас в рынке долю p времени, растягивает срок в 1/p раз.\n`);
console.log(`> Границы метода. Издержки считаются по видимым bid/ask снимка, проскальзывание и`);
console.log(`> частичное исполнение не моделируются. Вега и тета взяты из наших греков Блэка-76`);
console.log(`> (сверка с биржей живёт в записи checks). Автокорреляция меряется по одной траектории`);
console.log(`> длиной в запись, поэтому сама она оценена грубо: n_eff тут порядок величины, не точность.`);
