// pf-impl-1.mjs - ХОДОК ПОРТФЕЛЯ. Реализация 1 из двух независимых. READ-ONLY по данным.
//
// ЧТО МЕРЯЕТСЯ. Гипотеза: ценность правила выхода оказалась в ДЕКОНЦЕНТРАЦИИ, а не в выборе рынка.
// Если так, деконцентрацию дешевле взять прямо: держать несколько рынков сразу и не платить кругов
// за перекладки. Четыре руки при капитале $5000:
//   hold-1   лучший ОДИН рынок, вошли и держим до конца прогона
//   hold-pf  портфель по allocateCapital, вошли и держим до конца прогона
//   rule-1   правило выхода, одна позиция, решение раз в каданс
//   rule-pf  портфель с переразмещением раз в каданс
//
// ЧЕГО ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО. Своей арифметики начисления, своего распределителя капитала и
// своего выбора размера. Начисление считает `netAtSize` (то есть `paper.js`), размер и оболочку
// считает `bestSizeForMarket` (её выдача лежит в файле скана), капитал делит `allocateCapital`.
// Ограничение числа позиций k выражено ОГРАНИЧЕНИЕМ СПИСКА КАНДИДАТОВ (kmax лучших по нетто), после
// чего зовётся тот же самый распределитель: второго распределителя в проекте быть не должно.
//
// ВРЕМЕННОЕ ВЫРАВНИВАНИЕ. Решение в час t принимается по трейлингу [t-720, t) и никогда не смотрит
// вперёд. Реализованный доход считается по строкам ВПЕРЁД от t. Два ряда не смешиваются.

import fs from "node:fs";
import zlib from "node:zlib";
import { loadUniverse, loadCapacity, H, q, $ } from "./pf-lib.mjs";
import { APP } from "./paths.mjs";

const ENG = `${APP}/src/engine`;
const { netAtSize, costAtSize, allocateCapital, FA_SIZING_DEFAULTS } = await import(`${ENG}/fa/sizing.js`);
const { DEFAULT_COSTS } = await import(`${ENG}/costs.js`);

// Путь к скану задаётся снаружи: абсолютных путей на временное дерево в скриптах репозитория нет.
const SCAN = process.env.FA_PF_SCAN || process.argv[2];
if (!SCAN) throw new Error("путь к merged.json.gz не задан: FA_PF_SCAN или первый аргумент");

const CAPITAL = 5000; // капитал прогона
const CADENCE = 24; // каданс решения, часов
const N_STARTS = 12; // число стартов
const START_STEP = 60; // сдвиг между стартами, часов
const FIRST_START = H; // первый старт: раньше трейлинга в 720 часов решения не существует

// ─────────────────────────────────────────────────────────────────────────────
// СНАБЖЕНИЕ
// ─────────────────────────────────────────────────────────────────────────────

const scan = JSON.parse(zlib.gunzipSync(fs.readFileSync(SCAN)).toString("utf8"));
const byHour = new Map(scan.hours.map((h) => [h.t, h]));
const { markets } = loadUniverse();
const capacity = loadCapacity();
const rowsOf = new Map(markets.map((m) => [m.token, m.rows]));
const N_HOURS = markets[0].rows.length; // 8761

// Кривые удара кэшируются: они зависят только от рынка и стороны ноги.
const impCache = new Map();
function impactOf(token, config) {
  const key = `${token}|${config}`;
  let v = impCache.get(key);
  if (!v) {
    v = capacity.impactFor(token, config === "A" ? "short" : "long");
    impCache.set(key, v);
  }
  return v;
}

// РЕАЛИЗОВАННЫЙ БРУТТО за отрезок [from, to). Единственная точка начисления во всём файле.
const grossCache = new Map();
const NOCACHE = process.env.FA_PF_NOCACHE === "1";
let grossCalls = 0;
function grossOver(token, config, sizeUsd, from, to) {
  if (!(to > from)) return 0;
  const key = `${token}|${config}|${sizeUsd}|${from}|${to}`;
  // FA_PF_NOCACHE отключает кэш начисления. Кэш экономит часы счёта, но кэш с коллизией ключа даёт
  // правдоподобное неверное число молча, поэтому ответ обязан воспроизводиться и без него.
  if (!NOCACHE) {
    const hit = grossCache.get(key);
    if (hit !== undefined) return hit;
  }
  grossCalls += 1;
  const r = netAtSize({
    rows: rowsOf.get(token).slice(from, to),
    config, strategy: "two", sizeUsd,
    costs: DEFAULT_COSTS, impact: impactOf(token, config),
  });
  const v = r ? r.gross : 0;
  grossCache.set(key, v);
  return v;
}

// КРУГ ИЗДЕРЖЕК при размере. Круг покрывает и вход, и выход: позиция платит его РОВНО ОДИН РАЗ, в
// час своего открытия. Поэтому закрытие в конце горизонта отдельной статьи не имеет.
const costCache = new Map();
function roundTrip(token, config, sizeUsd) {
  const key = `${token}|${config}|${sizeUsd}`;
  const hit = costCache.get(key);
  if (hit !== undefined) return hit;
  const v = costAtSize({ sizeUsd, costs: DEFAULT_COSTS, impact: impactOf(token, config) });
  costCache.set(key, v);
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// ЦЕЛЬ РАСПРЕДЕЛИТЕЛЯ В ЧАС t
// ─────────────────────────────────────────────────────────────────────────────

// kmax отбирает КАНДИДАТОВ, а не делит деньги: деньги делит `allocateCapital`, и он один.
// Порядок отбора при равных нетто фиксирован по имени рынка, как и в самом распределителе:
// недетерминированный порядок сам по себе больше того, что мерят (замер О4 в sizing.js).
const targetCache = new Map();
function targetAt(t, kmax) {
  const key = `${t}|${kmax}`;
  const hit = targetCache.get(key);
  if (hit !== undefined) return hit;
  const entry = byHour.get(t);
  // Час решения ОБЯЗАН лежать на сетке скана. Подставить сюда ближайший час значило бы принимать
  // решение по устаревшему срезу и не сказать об этом, а это ровно тот класс дефекта, из-за
  // которого замеры этого проекта уже четырежды давали правдоподобное неверное число.
  if (!entry) throw new Error(`часа ${t} нет в скане: шаг скана ${scan.stride} не покрывает каданс ${CADENCE} при сдвиге стартов ${START_STEP}`);
  let ok = entry.ok;
  if (Number.isFinite(kmax)) {
    ok = [...ok].sort((a, b) => (b.n - a.n) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)).slice(0, kmax);
  }
  const configByToken = new Map(ok.map((x) => [x.k, x.c]));
  const curves = ok.map((x) => ({
    token: x.k, config: x.c, refusal: null,
    hull: x.h.map(([sizeUsd, net]) => ({ sizeUsd, net })),
  }));
  const { alloc } = allocateCapital(curves, CAPITAL, FA_SIZING_DEFAULTS);
  const pos = [...alloc.entries()]
    .map(([token, sizeUsd]) => ({ token, config: configByToken.get(token), sizeUsd }))
    .sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  targetCache.set(key, pos);
  return pos;
}

const idOf = (p) => `${p.token}|${p.config}|${p.sizeUsd}`;

// ─────────────────────────────────────────────────────────────────────────────
// ХОДОК
// ─────────────────────────────────────────────────────────────────────────────

// Прогон одной руки от часа start до часа end.
//   rule = false: одно решение в час start, дальше держим до конца.
//   rule = true:  решение в каждый час каданса по критерию правила выхода.
function walk({ start, end, kmax, rule }) {
  const points = [start];
  if (rule) for (let t = start + CADENCE; t < end; t += CADENCE) points.push(t);

  let cur = []; // текущие позиции
  let grossTotal = 0;
  let costTotal = 0;
  let trips = 0;
  const counts = []; // число одновременных позиций на каждом отрезке

  for (let i = 0; i < points.length; i += 1) {
    const t = points[i];
    const next = i + 1 < points.length ? points[i + 1] : end;

    if (!rule) {
      // РУКА УДЕРЖАНИЯ. Критерия нет: вошли тем, что дал распределитель, и держим.
      if (i === 0) {
        cur = targetAt(t, kmax);
        for (const p of cur) { costTotal += roundTrip(p.token, p.config, p.sizeUsd); trips += 1; }
      }
    } else {
      // КРИТЕРИЙ ПРАВИЛА. Трейлинговый брутто на окне [t-720, t): у текущих позиций при их
      // текущем размере, у целевых при целевом. Стоимость ЗАКРЫТИЯ текущих в критерий не входит:
      // при переоценке в конце горизонта она платится в любой ветке и сокращается.
      const holdGross = cur.reduce((s, p) => s + grossOver(p.token, p.config, p.sizeUsd, t - H, t), 0);
      const target = targetAt(t, kmax);
      const altGross = target.reduce((s, p) => s + grossOver(p.token, p.config, p.sizeUsd, t - H, t), 0);
      const held = new Set(cur.map(idOf));
      const changed = target.filter((p) => !held.has(idOf(p)));
      const changeCost = changed.reduce((s, p) => s + roundTrip(p.token, p.config, p.sizeUsd), 0);
      // Сравнения СТРОГИЕ: ничьи в пользу бездействия, потому что бездействие бесплатно.
      if (altGross - changeCost > holdGross && altGross - changeCost > 0) {
        costTotal += changeCost;
        trips += changed.length;
        cur = target;
      } else if (holdGross <= 0 && !(altGross - changeCost > 0)) {
        cur = []; // в кэш: держать нечего и брать нечего
      }
    }

    // НАЧИСЛЕНИЕ на отрезке [t, next). Аддитивность разбивки проверена отдельно (segmentCheck).
    for (const p of cur) grossTotal += grossOver(p.token, p.config, p.sizeUsd, t, next);
    counts.push(cur.length);
  }

  return { net: grossTotal - costTotal, gross: grossTotal, cost: costTotal, trips, medPos: q(counts, 0.5) };
}

// ─────────────────────────────────────────────────────────────────────────────
// ПРОВЕРКА АДДИТИВНОСТИ НАЧИСЛЕНИЯ
// ─────────────────────────────────────────────────────────────────────────────

// Начисление отрезками допустимо ТОЛЬКО если сумма отрезков равна одному длинному начислению за
// тот же период. Если не равна, ответ зависит от разбивки, и это надо назвать, а не замолчать.
function segmentCheck() {
  const t0 = FIRST_START;
  const t1 = t0 + CADENCE * 40;
  const probe = targetAt(t0, Infinity)[0] || { token: markets[0].token, config: "A", sizeUsd: 2000 };
  const rows = rowsOf.get(probe.token);
  const one = netAtSize({
    rows: rows.slice(t0, t1), config: probe.config, strategy: "two", sizeUsd: probe.sizeUsd,
    costs: DEFAULT_COSTS, impact: impactOf(probe.token, probe.config),
  }).gross;
  let sum = 0;
  for (let a = t0; a < t1; a += CADENCE) {
    sum += netAtSize({
      rows: rows.slice(a, Math.min(a + CADENCE, t1)), config: probe.config, strategy: "two",
      sizeUsd: probe.sizeUsd, costs: DEFAULT_COSTS, impact: impactOf(probe.token, probe.config),
    }).gross;
  }
  return { token: probe.token, config: probe.config, sizeUsd: probe.sizeUsd, hours: t1 - t0, one, sum, diff: sum - one };
}

// ─────────────────────────────────────────────────────────────────────────────
// ПРОГОН
// ─────────────────────────────────────────────────────────────────────────────

const starts = Array.from({ length: N_STARTS }, (_, i) => FIRST_START + i * START_STEP);
const lastStart = starts[starts.length - 1];
// "equal": все старты идут ОДИНАКОВОЕ число часов, последний обязан уложиться в год.
const EQUAL_LEN = N_HOURS - lastStart;
// "theirs": конец у всех один, последний час года. Так делал замер правила выхода, и из-за этого
// последний старт короче первого на 660 часов. Нужен только для СВЕРКИ с их числами.
const endOf = (start, lenMode) => (lenMode === "equal" ? start + EQUAL_LEN : N_HOURS);

// ПРЕДПОЛЁТНАЯ СВЕРКА СЕТКИ. Все часы решения обеих длин обязаны быть в скане ДО начала счёта:
// упасть на 300-м прогоне после часа работы значит потерять час на том, что видно сразу.
{
  const need = new Set();
  for (const lenMode of ["equal", "theirs"]) {
    for (const s of starts) {
      const e = endOf(s, lenMode);
      need.add(s);
      for (let t = s + CADENCE; t < e; t += CADENCE) need.add(t);
    }
  }
  const miss = [...need].filter((t) => !byHour.has(t)).sort((a, b) => a - b);
  console.error(`сетка решений: нужно часов ${need.size}, в скане ${byHour.size} (${scan.from}..${scan.to} шаг ${scan.stride}), не хватает ${miss.length}`);
  if (miss.length) throw new Error(`сетка скана не покрывает каданс: нет часов ${miss.slice(0, 8).join(",")}${miss.length > 8 ? " ..." : ""}`);
}

const ARMS = [
  { mode: "hold-1", kmax: 1, rule: false },
  { mode: "hold-pf", kmax: Infinity, rule: false },
  { mode: "rule-1", kmax: 1, rule: true },
  { mode: "rule-pf", kmax: Infinity, rule: true },
];

const out = [];
for (const lenMode of ["equal", "theirs"]) {
  for (const arm of ARMS) {
    const runs = starts.map((s) => walk({ start: s, end: endOf(s, lenMode), kmax: arm.kmax, rule: arm.rule }));
    const nets = runs.map((r) => r.net);
    const rec = {
      mode: arm.mode,
      lenMode,
      medianNet: q(nets, 0.5),
      minNet: Math.min(...nets),
      maxNet: Math.max(...nets),
      medianPositions: q(runs.map((r) => r.medPos), 0.5),
      medianTrips: q(runs.map((r) => r.trips), 0.5),
    };
    out.push(rec);
    console.error(`${lenMode} ${arm.mode}: медиана ${$(rec.medianNet)} [${$(rec.minNet)} .. ${$(rec.maxNet)}] `
      + `позиций ${rec.medianPositions} кругов ${rec.medianTrips} | нетто ${nets.map((x) => x.toFixed(2)).join(" ")}`);
  }
}

const seg = segmentCheck();
console.error(`аддитивность: ${seg.token}/${seg.config} $${seg.sizeUsd} за ${seg.hours} ч, `
  + `длинное ${seg.one.toFixed(10)}, сумма отрезков ${seg.sum.toFixed(10)}, разница ${seg.diff.toExponential(3)}`);
console.error(`старты: ${starts.join(",")}; equal длина ${EQUAL_LEN} ч; часов в году ${N_HOURS}; `
  + `вызовов начисления ${grossCalls}`);

console.log(JSON.stringify({ arms: out, segment: seg, starts, equalLen: EQUAL_LEN, nHours: N_HOURS }, null, 2));
