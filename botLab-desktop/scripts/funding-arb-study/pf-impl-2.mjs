// pf-impl-2.mjs - ХОДОК ПОРТФЕЛЯ. Независимая реализация номер 2.
//
// ЧТО МЕРЯЕТСЯ. Правило выхода бота 1 не бьёт простое удержание по медиане, но сильно поднимает
// пол. Значит его ценность в ДЕКОНЦЕНТРАЦИИ, а не в выборе рынка. Гипотеза: деконцентрацию дешевле
// взять прямо, держа несколько рынков сразу и не оплачивая кругов за перекладки. Четыре руки:
//   hold-1   лучший ОДИН рынок, держим до конца прогона
//   hold-pf  портфель через allocateCapital, держим до конца прогона
//   rule-1   правило выхода, одна позиция, решение раз в каданс
//   rule-pf  портфель с переразмещением раз в каданс
// Разница hold-pf минус hold-1 это цена деконцентрации БЕЗ перекладок; разница rule-* минус hold-*
// это то, что добавляет сверху сама перекладка.
//
// ЧЕГО ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО. Своей арифметики начисления и своего распределителя капитала.
// Брутто считает `netAtSize` движка, круг издержек `costAtSize`, размещение `allocateCapital`.
// Ограничение числа позиций выражено ограничением СПИСКА КАНДИДАТОВ, а не вторым распределителем:
// иначе размер решали бы две части системы разными правилами, а этот класс дефекта проект ловил
// уже четырежды.
//
// ВРЕМЕННОЕ ВЫРАВНИВАНИЕ. Решение в час t принимается по трейлингу rows[t-720, t) и вперёд не
// смотрит никогда. Реализованный доход считается по строкам ВПЕРЁД от часа открытия позиции.
//
// ЗАПУСК:
//   PF_SCAN=<merged.json.gz или каталог с part-*.json.gz> node scripts/funding-arb-study/pf-impl-2.mjs

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { loadUniverse, loadCapacity, H, q } from "./pf-lib.mjs";
import { allocateCapital, netAtSize, costAtSize, FA_SIZING_DEFAULTS } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";

// ── Параметры замера. Все до одного из задания, ни один не подбирается здесь.
const CAPITAL = 5000;
const CADENCE = 24;      // часов между точками решения
const N_STARTS = 12;
const START_STEP = 60;   // сдвиг стартов, часов
const FIRST_START = H;   // первый старт с часа 720: раньше трейлинга нет

// Выгрузка сканера. Абсолютных литералов на временное дерево в репозитории быть не должно, поэтому
// путь приходит переменной окружения; принимается и один файл, и каталог с кусками.
const SCAN = process.env.PF_SCAN || path.resolve(process.cwd(), "pf-scan");

const log = (...a) => process.stderr.write(a.join(" ") + "\n");
const sum = (a) => a.reduce((s, x) => s + x, 0);

// ─────────────────────────────────────────────────────────────────────────────
// ВСЕЛЕННАЯ И ГОРИЗОНТЫ
// ─────────────────────────────────────────────────────────────────────────────

log("читаю вселенную...");
const { markets, skipped } = loadUniverse();
const rowsOf = new Map(markets.map((m) => [m.token, m.rows]));
const N = markets[0].rows.length; // часов в году; `loadUniverse` требует одинаковой длины у всех
log(`рынков ${markets.length}, пропущено ${skipped.length}, строк ${N}`);

const { impactFor } = loadCapacity();
// Мемоизация: `impactFor` строит массивы узлов заново на каждый зов, а зовётся он десятки тысяч раз.
const impCache = new Map();
const imp = (token, side) => {
  const k = `${token}|${side}`;
  let v = impCache.get(k);
  if (!v) { v = impactFor(token, side); impCache.set(k, v); }
  return v;
};
const sideOf = (config) => (config === "A" ? "short" : "long");

const starts = Array.from({ length: N_STARTS }, (_, i) => FIRST_START + i * START_STEP);
const lastStart = starts[starts.length - 1];
// equal: все старты идут ОДИНАКОВОЕ число часов; L максимальное, при котором последний старт
// укладывается в год (конец последнего равен 720+660+L). Это основной режим.
// theirs: конец у всех один, последний час года. Так мерили правило выхода, и из-за этого
// последний старт короче первого ровно на 660 ч. Нужен для СВЕРКИ с их числами.
const L_EQUAL = N - lastStart;
const endFor = (start, lenMode) => (lenMode === "equal" ? start + L_EQUAL : N);
log(`старты ${starts[0]}..${lastStart}, L(equal) = ${L_EQUAL} ч, конец(theirs) = ${N}`);

// Точки решения всех рук. Считаются ДО чтения выгрузки: часов в ней восемь тысяч, а нужны из них
// шесть с половиной сотен, и держать в памяти остальные незачем.
const need = new Set();
for (const start of starts) {
  for (const lenMode of ["equal", "theirs"]) {
    const end = endFor(start, lenMode);
    need.add(start);
    for (let t = start + CADENCE; t < end; t += CADENCE) need.add(t);
  }
}
log(`точек решения ${need.size}`);

// ─────────────────────────────────────────────────────────────────────────────
// ВЫГРУЗКА СКАНЕРА
// ─────────────────────────────────────────────────────────────────────────────

const scanFiles = fs.statSync(SCAN).isDirectory()
  ? fs.readdirSync(SCAN).filter((f) => f.endsWith(".json.gz")).sort().map((f) => path.join(SCAN, f))
  : [SCAN];
log(`читаю выгрузку: ${scanFiles.length} файл(ов) из ${SCAN}`);
const byHour = new Map();
for (const f of scanFiles) {
  const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"));
  for (const h of j.hours) if (need.has(h.t)) byHour.set(h.t, h.ok);
}
const missing = [...need].filter((t) => !byHour.has(t)).sort((a, b) => a - b);
if (missing.length) {
  // Молчаливый пропуск часа решения означал бы, что каданс на самом деле другой, а замер об этом
  // не сказал. Такой замер лучше не проводить вовсе.
  log(`НЕТ В ВЫГРУЗКЕ ${missing.length} часов решения, первые: ${missing.slice(0, 10).join(",")}`);
  throw new Error("выгрузка сканера не покрывает точки решения");
}
log(`все ${need.size} часов решения на месте`);

// ─────────────────────────────────────────────────────────────────────────────
// ОБРАЩЕНИЯ К ДВИЖКУ, С КЭШЕМ. Кэш не меняет ни одного разряда: один и тот же трейлинговый брутто
// спрашивают четыре руки и двенадцать стартов, и без кэша замер считался бы часами.
// ─────────────────────────────────────────────────────────────────────────────

const keySize = (s) => s.toPrecision(15);
const grossCache = new Map();
let grossCalls = 0;

// Брутто по строкам [a, b) при размере sizeUsd. ЕДИНСТВЕННАЯ точка начисления в этом файле.
function grossOver(token, config, sizeUsd, a, b) {
  const k = `${token}|${config}|${keySize(sizeUsd)}|${a}|${b}`;
  const hit = grossCache.get(k);
  if (hit !== undefined) return hit;
  grossCalls += 1;
  const r = netAtSize({
    rows: rowsOf.get(token).slice(a, b), config, strategy: "two", sizeUsd,
    costs: DEFAULT_COSTS, impact: imp(token, sideOf(config)), token,
  });
  const g = r ? r.gross : 0;
  grossCache.set(k, g);
  return g;
}

// Трейлинговый брутто на окне [t-720, t) при размере sizeUsd. Это ОЦЕНКА, которую видит правило.
const trailGross = (token, config, sizeUsd, t) => grossOver(token, config, sizeUsd, t - H, t);

const rtCache = new Map();
function roundTrip(token, config, sizeUsd) {
  const k = `${token}|${config}|${keySize(sizeUsd)}`;
  const hit = rtCache.get(k);
  if (hit !== undefined) return hit;
  const c = costAtSize({ sizeUsd, costs: DEFAULT_COSTS, impact: imp(token, sideOf(config)) });
  rtCache.set(k, c);
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// ЦЕЛЬ РАЗМЕЩЕНИЯ. Зависит ТОЛЬКО от часа и от kmax: капитал у всех рук один, кривые в этом часу
// одни и те же. Поэтому цель считается один раз на пару (час, kmax) и раздаётся всем стартам.
// ─────────────────────────────────────────────────────────────────────────────

const targetCache = new Map();
function targetAt(t, kmax) {
  const k = `${t}|${kmax}`;
  const hit = targetCache.get(k);
  if (hit) return hit;
  const ok = byHour.get(t);
  if (!ok) throw new Error(`в выгрузке нет часа ${t}`);
  // Ограничение числа позиций это ограничение СПИСКА КАНДИДАТОВ: взять kmax лучших по нетто.
  // Порядок при равных нетто фиксирован по имени рынка, как О4 в sizing.js: недетерминированный
  // порядок отбора сам по себе больше измеряемого разрыва конструкций.
  const sorted = [...ok].sort((a, b) => (b.n - a.n) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const take = Number.isFinite(kmax) ? sorted.slice(0, kmax) : sorted;
  const curves = take.map((x) => ({
    token: x.k, refusal: null,
    hull: x.h.map(([sizeUsd, net]) => ({ sizeUsd, net })),
  }));
  const cfgOf = new Map(take.map((x) => [x.k, x.c]));
  const res = allocateCapital(curves, CAPITAL, FA_SIZING_DEFAULTS);
  const pos = [...res.alloc.entries()]
    .map(([token, sizeUsd]) => ({ token, config: cfgOf.get(token), sizeUsd }))
    .sort((a, b) => (a.token < b.token ? -1 : 1));
  targetCache.set(k, pos);
  return pos;
}

// ─────────────────────────────────────────────────────────────────────────────
// ХОДОК
// ─────────────────────────────────────────────────────────────────────────────

// Позиция ТОЖДЕСТВЕННА, если совпали токен, конфигурация ноги и размер. Ровно это условие решает,
// платится ли круг: изменённая позиция переоткрывается, неизменённая не трогается вовсе.
const idOf = (p) => `${p.token}|${p.config}|${keySize(p.sizeUsd)}`;

function walk({ mode, start, end }) {
  const kmax = mode === "hold-1" || mode === "rule-1" ? 1 : Infinity;
  const isRule = mode === "rule-1" || mode === "rule-pf";

  const decisions = [start];
  if (isRule) for (let t = start + CADENCE; t < end; t += CADENCE) decisions.push(t);

  let cur = [];        // открытые позиции
  const closed = [];   // прожитые позиции: по одному оплаченному кругу на каждую
  const counts = [];   // число одновременных позиций в каждой точке решения
  const deployed = []; // сколько долларов из капитала реально стоит в рынке
  let switches = 0;    // сколько раз правило переразмещалось
  let cashHours = 0;   // сколько точек решения провели в кэше

  for (const t of decisions) {
    if (t === start) {
      cur = targetAt(t, kmax).map((p) => ({ ...p, openHour: t }));
      counts.push(cur.length);
      deployed.push(sum(cur.map((p) => p.sizeUsd)));
      continue;
    }
    // КРИТЕРИЙ. Три числа: что даёт удержание, что даёт цель, во что обходится переход.
    const holdGross = sum(cur.map((p) => trailGross(p.token, p.config, p.sizeUsd, t)));
    const tgt = targetAt(t, kmax);
    const altGross = sum(tgt.map((p) => trailGross(p.token, p.config, p.sizeUsd, t)));
    const curIds = new Set(cur.map(idOf));
    // Круг платят только ИЗМЕНЁННЫЕ позиции. Стоимость ЗАКРЫТИЯ текущих в критерий не входит: она
    // платится в любой ветке при переоценке в конце горизонта и сокращается.
    const changeCost = sum(tgt.filter((p) => !curIds.has(idOf(p))).map((p) => roundTrip(p.token, p.config, p.sizeUsd)));
    const gain = altGross - changeCost;

    // Сравнения СТРОГИЕ: ничьи в пользу бездействия, потому что бездействие бесплатно.
    if (gain > holdGross && gain > 0) {
      const tgtIds = new Set(tgt.map(idOf));
      const kept = new Map();
      for (const p of cur) {
        if (tgtIds.has(idOf(p))) kept.set(idOf(p), p);
        else closed.push({ ...p, closeHour: t });
      }
      cur = tgt.map((p) => kept.get(idOf(p)) || { ...p, openHour: t });
      switches += 1;
    } else if (holdGross <= 0 && !(gain > 0)) {
      for (const p of cur) closed.push({ ...p, closeHour: t });
      cur = [];
    }
    if (!cur.length) cashHours += 1;
    counts.push(cur.length);
    deployed.push(sum(cur.map((p) => p.sizeUsd)));
  }
  for (const p of cur) closed.push({ ...p, closeHour: end });

  // Нетто прогона это сумма по ПРОЖИТЫМ позициям: брутто за её собственный срок минус один круг.
  let net = 0;
  for (const p of closed) {
    if (p.closeHour <= p.openHour) continue;
    net += grossOver(p.token, p.config, p.sizeUsd, p.openHour, p.closeHour) - roundTrip(p.token, p.config, p.sizeUsd);
  }
  return {
    net, trips: closed.length, medPositions: q(counts, 0.5),
    medDeployed: q(deployed, 0.5), switches, cashHours, decisions: decisions.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ПРОВЕРКА АДДИТИВНОСТИ. Если сумма отрезков не равна одному длинному начислению, доход зависит от
// того, где расставлены точки решения, и все числа ниже надо читать иначе.
// ─────────────────────────────────────────────────────────────────────────────

function segmentCheck(a, b) {
  const probe = targetAt(a, Infinity).slice(0, 5);
  const out = [];
  for (const p of probe) {
    const one = grossOver(p.token, p.config, p.sizeUsd, a, b);
    let parts = 0;
    for (let x = a; x < b; x += CADENCE) parts += grossOver(p.token, p.config, p.sizeUsd, x, Math.min(b, x + CADENCE));
    out.push({
      token: p.token, config: p.config, sizeUsd: p.sizeUsd, fromHour: a, toHour: b,
      oneShot: one, sumOfSegments: parts, diff: parts - one,
      relDiff: one !== 0 ? Math.abs(parts - one) / Math.abs(one) : 0,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// ПРОГОН
// ─────────────────────────────────────────────────────────────────────────────

const segs = segmentCheck(FIRST_START, FIRST_START + L_EQUAL);
log("аддитивность: " + segs.map((s) => `${s.token} ${s.oneShot.toFixed(6)} против ${s.sumOfSegments.toFixed(6)} (отн ${s.relDiff.toExponential(2)})`).join("; "));

const MODES = ["hold-1", "hold-pf", "rule-1", "rule-pf"];
const arms = [];
for (const mode of MODES) {
  for (const lenMode of ["equal", "theirs"]) {
    const t0 = Date.now();
    const runs = starts.map((start) => walk({ mode, start, end: endFor(start, lenMode) }));
    const nets = runs.map((r) => r.net);
    const row = {
      mode, lenMode,
      medianNet: q(nets, 0.5), minNet: Math.min(...nets), maxNet: Math.max(...nets),
      medianPositions: q(runs.map((r) => r.medPositions), 0.5),
      medianTrips: q(runs.map((r) => r.trips), 0.5),
      medianDeployedUsd: q(runs.map((r) => r.medDeployed), 0.5),
      medianSwitches: q(runs.map((r) => r.switches), 0.5),
      medianCashPoints: q(runs.map((r) => r.cashHours), 0.5),
      decisionPoints: runs[0].decisions,
      nets,
    };
    arms.push(row);
    log(`${mode}/${lenMode}: медиана ${row.medianNet.toFixed(2)}, мин ${row.minNet.toFixed(2)}, макс ${row.maxNet.toFixed(2)}, `
      + `поз ${row.medianPositions}, занято $${row.medianDeployedUsd.toFixed(0)}, кругов ${row.medianTrips}, перекладок ${row.medianSwitches}; `
      + `${((Date.now() - t0) / 1000).toFixed(0)} с, зовов движка всего ${grossCalls}`);
  }
}

process.stdout.write(JSON.stringify({ N, L_EQUAL, capital: CAPITAL, cadence: CADENCE, starts, segs, arms }, null, 2) + "\n");
