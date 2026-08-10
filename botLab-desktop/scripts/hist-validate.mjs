#!/usr/bin/env node
// hist-validate.mjs - сверка ВОССТАНОВЛЕННОЙ поверхности с ЗАПИСАННОЙ. READ-ONLY, без сети.
//
// ЗАЧЕМ ЭТОТ ШАГ ГЛАВНЫЙ. Годовой бектест строится на двух допущениях, и оба надо не объявить, а
// проверить:
//   (1) волатильность, снятая с ленты ОБРАТНЫХ опционов (BTC-*), верна для ЛИНЕЙНЫХ (BTC_USDC-*),
//       которыми сканер торгует;
//   (2) подгонка по редким сделкам воспроизводит непрерывный марк биржи достаточно точно, чтобы
//       на ней считать вердикты условий.
// У нас есть отрезок, где известна ИСТИНА: запись прогона 5 (2026-08-04..07) содержит настоящие
// mark_iv, bid/ask, форвард и греки по 428 инструментам каждые пять минут. Восстанавливаем те же
// сутки из ленты и сверяем инструмент за инструментом.
//
// ЕСЛИ СВЕРКА НЕ СХОДИТСЯ - ГОДОВОЙ БЕКТЕСТ НИЧЕГО НЕ СТОИТ, и это надо сказать, а не обойти.
// Поэтому скрипт заканчивается явным вердиктом по заранее названным порогам, а не «посмотрите
// таблицы сами».
//
// ЧТО СВЕРЯЕТСЯ И В КАКИХ ЕДИНИЦАХ:
//   IV      - в ПУНКТАХ волатильности (абсолютная разность). Это единица, в которой живёт вся
//             экономика стратегии: круг издержек стоит 1.52 пункта, запас У2 требует 5 пунктов.
//             Ошибка восстановления обязана быть заметно меньше круга, иначе бектест меряет себя.
//   форвард - в процентах (он определяет moneyness и дельту);
//   дельта  - абсолютная разность (по ней пресеты отбирают страйк, полоса 0.35-0.55);
//   марк    - в процентах премии;
//   тета    - в процентах (её лимит У13 стоит в пресетах).
// Спред НЕ сверяется: в истории его нет вовсе, он моделируется, и сравнение модели с записью,
// из которой модель и снята, было бы проверкой самой себя.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const fin = (x) => Number.isFinite(x);
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

const TRUTH = argOf("--truth");
const RECON = argOf("--recon");
if (!TRUTH || !RECON) {
  console.error(`нужны --truth <каталог записи> и --recon <каталог восстановления>

  --tol-sec <n>   допуск подбора снимка по времени (по умолчанию 150 = половина каданса записи)
  --band <a,b>    полоса |дельты| для отдельного среза (по умолчанию 0.35,0.55)`);
  process.exit(1);
}
const TOL_MS = Number(argOf("--tol-sec", "150")) * 1000;
const BAND = (argOf("--band", "0.35,0.55")).split(",").map(Number);

const recDir = (d) => (existsSync(join(d, "scan-records")) ? join(d, "scan-records") : d);
function loadSurface(dir) {
  const byTs = new Map();
  const D = recDir(dir);
  for (const f of readdirSync(D).filter((x) => x.includes("-surface-") && x.endsWith(".ndjson")).sort()) {
    for (const line of readFileSync(join(D, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      let m = byTs.get(r.ts);
      if (!m) { m = new Map(); byTs.set(r.ts, m); }
      m.set(r.n, r);
    }
  }
  return byTs;
}

const truth = loadSurface(TRUTH);
const recon = loadSurface(RECON);
if (!truth.size || !recon.size) { console.error("одна из записей пуста"); process.exit(1); }
const truthTimes = [...truth.keys()].sort((a, b) => a - b);

// Ближайший по времени снимок истины (в обе стороны: сверяется ТОЧНОСТЬ поверхности, а не
// свежесть - правило «только назад» действует при построении, а не при сравнении).
function nearestTruth(ts) {
  let lo = 0, hi = truthTimes.length - 1, best = null, bd = Infinity;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const d = Math.abs(truthTimes[m] - ts);
    if (d < bd) { bd = d; best = truthTimes[m]; }
    if (truthTimes[m] < ts) lo = m + 1; else hi = m - 1;
  }
  return bd <= TOL_MS ? best : null;
}

const rows = [];
let snapsMatched = 0, snapsMissed = 0, truthOnly = 0, reconOnly = 0;
for (const [ts, rMap] of recon) {
  const tt = nearestTruth(ts);
  if (tt == null) { snapsMissed += 1; continue; }
  snapsMatched += 1;
  const tMap = truth.get(tt);
  for (const [name, t] of tMap) {
    const r = rMap.get(name);
    if (!r) { truthOnly += 1; continue; }
  }
  for (const [name, r] of rMap) {
    const t = tMap.get(name);
    if (!t) { reconOnly += 1; continue; }
    if (!(fin(t.iv) && fin(r.iv) && fin(t.f) && fin(r.f))) continue;
    rows.push({
      name, ts, days: t.h / 24, deltaTruth: Math.abs(t.d ?? NaN),
      dIv: r.iv - t.iv,
      dFwdPct: ((r.f - t.f) / t.f) * 100,
      dDelta: fin(r.d) && fin(t.d) ? r.d - t.d : null,
      dMarkPct: fin(r.m) && t.m > 0 ? ((r.m - t.m) / t.m) * 100 : null,
      dThetaPct: fin(r.th) && Math.abs(t.th) > 0 ? ((r.th - t.th) / Math.abs(t.th)) * 100 : null,
      ivTruth: t.iv,
    });
  }
}
if (!rows.length) { console.error("совпавших инструментов нет - сверять нечего"); process.exit(1); }

const q = (a, p) => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return null;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const f = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");
const mae = (a) => { const s = a.filter(fin); return s.length ? s.reduce((x, y) => x + Math.abs(y), 0) / s.length : null; };
const stat = (a) => ({ n: a.filter(fin).length, med: q(a, 0.5), mae: mae(a), p90: q(a.map(Math.abs), 0.9), p10: q(a, 0.1), p90s: q(a, 0.9) });

const line = (label, a, unit) => {
  const s = stat(a);
  console.log(`| ${label} | ${s.n} | ${f(s.med, 3)} | **${f(s.mae, 3)}** | ${f(s.p90, 3)} | ${f(s.p10, 3)} .. ${f(s.p90s, 3)} | ${unit} |`);
};

const DAYS_B = [[0, 2], [2, 7], [7, 14], [14, 28], [28, 56], [56, 90]];
const inBand = rows.filter((r) => r.deltaTruth >= BAND[0] && r.deltaTruth <= BAND[1]);

console.log(`# Сверка восстановленной поверхности с записанной\n`);
console.log(`Истина: \`${TRUTH}\` · восстановление: \`${RECON}\``);
console.log(`Снимков восстановления сопоставлено ${snapsMatched}, без пары ${snapsMissed} (допуск ${TOL_MS / 1000}с).`);
console.log(`Совпавших строк ${rows.length}; в записи есть, в восстановлении нет: ${truthOnly}; наоборот: ${reconOnly}.\n`);

console.log(`## 1 · Ошибка по всем совпавшим инструментам\n`);
console.log(`| величина | n | медиана | средняя |ошибка| | p90 |ошибки| | полоса 10-90% | единица |`);
console.log(`|---|---|---|---|---|---|---|`);
line("IV", rows.map((r) => r.dIv), "пункты воли");
line("форвард", rows.map((r) => r.dFwdPct), "% форварда");
line("дельта", rows.map((r) => r.dDelta), "абсолютная");
line("марк", rows.map((r) => r.dMarkPct), "% премии");
line("тета", rows.map((r) => r.dThetaPct), "% теты");

console.log(`\n## 2 · Полоса дельты ${BAND[0]}-${BAND[1]}, которую пресеты реально покупают\n`);
console.log(`| величина | n | медиана | средняя |ошибка| | p90 |ошибки| | полоса 10-90% | единица |`);
console.log(`|---|---|---|---|---|---|---|`);
line("IV", inBand.map((r) => r.dIv), "пункты воли");
line("дельта", inBand.map((r) => r.dDelta), "абсолютная");
line("марк", inBand.map((r) => r.dMarkPct), "% премии");
line("тета", inBand.map((r) => r.dThetaPct), "% теты");

console.log(`\n## 3 · Ошибка IV по сроку (полоса дельты ${BAND[0]}-${BAND[1]})\n`);
console.log(`| срок | n | медиана, п.п. | средняя |ошибка|, п.п. | p90, п.п. | медиана IV записи |`);
console.log(`|---|---|---|---|---|---|`);
for (const [a, b] of DAYS_B) {
  const g = inBand.filter((r) => r.days >= a && r.days < b);
  if (g.length < 20) { console.log(`| ${a}-${b} дн | ${g.length} | н/д | н/д | н/д | н/д |`); continue; }
  const s = stat(g.map((r) => r.dIv));
  console.log(`| ${a}-${b} дн | ${s.n} | ${f(s.med, 2)} | **${f(s.mae, 2)}** | ${f(s.p90, 2)} | ${f(q(g.map((r) => r.ivTruth), 0.5), 1)} |`);
}

console.log(`\n## 4 · Покрытие: сколько инструментов записи восстановление вообще выдало\n`);
const covered = rows.length / (rows.length + truthOnly);
console.log(`| величина | значение |`);
console.log(`|---|---|`);
console.log(`| строк записи покрыто восстановлением | ${f(covered * 100, 1)}% |`);
console.log(`| строк восстановления без пары в записи | ${reconOnly} |`);
console.log(`\nНепокрытое это не сбой: правила П3 и П4 запрещают продолжать смайл за наблюдённые`);
console.log(`страйки и экстраполировать по сроку, поэтому дальние крылья честно остаются без значения.`);

// ── вердикт по порогам, названным ЗАРАНЕЕ
const ivMae = mae(inBand.map((r) => r.dIv));
const dMae = mae(inBand.map((r) => r.dDelta));
const fwdMae = mae(rows.map((r) => r.dFwdPct));
const ROUND_TRIP_IV_PTS = 1.52; // круг издержек, аудит 2026-08-08
console.log(`\n## 5 · Вердикт\n`);
console.log(`Пороги назначены до замера и привязаны к экономике, а не к красоте чисел:`);
console.log(`- ошибка IV обязана быть заметно меньше круга издержек **${ROUND_TRIP_IV_PTS} пункта** - иначе`);
console.log(`  бектест не отличит край стратегии от собственного шума. Порог: средняя |ошибка| < 0.50 п.п.`);
console.log(`- ошибка дельты < 0.02: полоса отбора 0.35-0.55 шириной 0.20, десятая часть её ширины`);
console.log(`  не переставляет инструменты между «годен» и «негоден».`);
console.log(`- ошибка форварда < 0.10%: он входит в moneyness и в дельту.\n`);
const checks = [
  ["ошибка IV в полосе дельты", ivMae, 0.5, "п.п.", 2],
  ["ошибка дельты в полосе", dMae, 0.02, "", 4],
  ["ошибка форварда", fwdMae, 0.1, "%", 4],
];
let allOk = true;
console.log(`| проверка | получено | порог | вердикт |`);
console.log(`|---|---|---|---|`);
for (const [label, got, lim, unit, dg] of checks) {
  const ok = fin(got) && Math.abs(got) < lim;
  if (!ok) allOk = false;
  console.log(`| ${label} | ${f(got, dg)}${unit} | < ${lim}${unit} | ${ok ? "**сходится**" : "**НЕ СХОДИТСЯ**"} |`);
}
console.log(`\n**${allOk
  ? "Восстановление годится: на сутках, где известна истина, поверхность воспроизводится точнее, чем стоит круг издержек."
  : "Восстановление НЕ годится. Годовой бектест на этой поверхности считать нельзя, пока расхождение не объяснено."}**`);
console.log(`\n> Сверка сделана на ${snapsMatched} снимках одних и тех же суток. Она доказывает точность`);
console.log(`> ПЕРЕНОСА волатильности с обратной ленты на линейные инструменты и качество подгонки, но`);
console.log(`> не переносится автоматически на месяцы с иной ликвидностью: доля меток без подгонки`);
console.log(`> печатается hist-build отдельно и за год её надо смотреть саму по себе.`);
process.exit(allOk ? 0 : 2);
