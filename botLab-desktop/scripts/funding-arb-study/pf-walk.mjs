// pf-walk.mjs - ОБЩИЙ ХОДОК ПОРТФЕЛЯ. READ-ONLY, решений тут нет, только их исполнение.
//
// ЧТО ПРОВЕРЯЕТСЯ ЭТИМ ФАЙЛОМ. Гипотеза: ценность правила выхода фазы 3 оказалась в
// ДЕКОНЦЕНТРАЦИИ, а не в выборе рынка (края у перекладки не нашли). Если так, деконцентрацию
// дешевле взять прямо: держать несколько рынков сразу, не платя кругов за перекладки. Разбавление
// этому благоприятствует, потому что доход равен pot*S/(B+S) и ВЫПУКЛ по S: при одинаковых рынках
// сумма по k рынкам равна C*pot/(B + C/k) и растёт по k. Против играет качество: дробя капитал,
// приходится брать рынки хуже лучшего. Что перевесит, арифметикой не решается, только замером.
//
// ЧЕТЫРЕ РУКИ, И ПЕРВЫЕ ДВЕ ГЛАВНЫЕ.
//   hold-1   вошли в лучший рынок один раз и держим до конца      (база фазы 3)
//   hold-pf  распределили капитал по рынкам один раз и держим     (ЧИСТАЯ ГИПОТЕЗА)
//   rule-1   правило выхода фазы 3, одна позиция                  (их $1016.93 при кадансе 24)
//   rule-pf  портфель с переразмещением по тому же критерию
// Первые две отвечают на вопрос без всякого правила выхода: если hold-pf бьёт hold-1, ценность
// в форме портфеля, а не в правиле.
//
// ОДИН КОД ДЛЯ ВСЕХ k, И ЭТО НАМЕРЕННО. k = 1 получается ограничением списка кандидатов до одного
// лучшего, а не отдельной веткой. Две ветки под одну задачу этот проект ловил четырежды.
//
// ДЛИНА ПРОГОНА. Стенд фазы 3 сдвигал НАЧАЛО и держал конец, отчего последний старт короче первого
// на 660 ч (8.2%), и это давало 42% размаха правила механически. Здесь длина ОДИНАКОВА у всех
// стартов (`--len equal`), а режим `--len theirs` воспроизводит их соглашение для сверки.

import fs from "node:fs";
import zlib from "node:zlib";
import { loadUniverse, loadCapacity, H } from "./pf-lib.mjs";
import { allocateCapital, netAtSize, costAtSize, FA_SIZING_DEFAULTS } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";

export const sideOf = (config) => (config === "A" ? "short" : "long");

export function loadScan(file) {
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  const byHour = new Map();
  for (const h of d.hours) byHour.set(h.t, h.ok);
  return byHour;
}

export function makeEnv() {
  const { markets } = loadUniverse();
  const cap = loadCapacity();
  const rowsOf = new Map(markets.map((m) => [m.token, m.rows]));
  const YEAR = Math.min(...markets.map((m) => m.rows.length));
  const impactOf = (token, config) => cap.impactFor(token, sideOf(config));

  // Реализованный БРУТТО за отрезок [from, from+len) при размере S. Считает движок, своей
  // арифметики начисления здесь нет: иначе замер доказывал бы собственную реализацию.
  const grossOn = (token, config, sizeUsd, from, len) => {
    const rows = rowsOf.get(token);
    if (!rows || from < 0 || len <= 0) return NaN;
    const seg = rows.slice(from, from + len);
    if (seg.length !== len) return NaN;
    const r = netAtSize({ rows: seg, config, strategy: "two", sizeUsd, costs: DEFAULT_COSTS, impact: impactOf(token, config) });
    return r ? r.gross : NaN;
  };
  const costOn = (token, config, sizeUsd) =>
    costAtSize({ sizeUsd, costs: DEFAULT_COSTS, impact: impactOf(token, config) });

  return { markets, YEAR, grossOn, costOn };
}

// Кандидаты, ограниченные числом рынков. Ограничение накладывается НА СПИСОК, а не на
// распределитель: второй распределитель под ту же задачу означал бы две реализации одного правила.
function candidates(ok, kmax) {
  const arms = ok.map((c) => ({ token: c.k, config: c.c, hull: c.h.map(([sizeUsd, net]) => ({ sizeUsd, net })), netUsd: c.n }));
  if (!Number.isFinite(kmax)) return arms;
  return [...arms].sort((a, b) => b.netUsd - a.netUsd).slice(0, kmax);
}

// Целевое размещение при данном капитале. Возвращает Map token -> { config, sizeUsd }.
function target(ok, capital, kmax) {
  const arms = candidates(ok, kmax);
  const { alloc } = allocateCapital(arms, capital, FA_SIZING_DEFAULTS);
  const cfgOf = new Map(arms.map((a) => [a.token, a.config]));
  const out = new Map();
  for (const [token, sizeUsd] of alloc) out.set(token, { config: cfgOf.get(token), sizeUsd });
  return out;
}

const keyOf = (token, p) => `${token}/${p.config}/${p.sizeUsd.toFixed(6)}`;

export function walk({ scan, env, capital = 5000, cadence = 24, kmax = Infinity, mode = "hold-pf", first, last }) {
  const { YEAR, grossOn, costOn } = env;
  const end = Math.min(last ?? YEAR, YEAR);
  const hours = [];
  for (let t = first; t <= end; t += cadence) if (scan.has(t)) hours.push(t);

  const pos = new Map(); // token -> { config, sizeUsd, at }
  let realized = 0;
  let costs = 0;
  const tally = { open: 0, close: 0, resize: 0, rebalances: 0, idle: 0, hold: 0, cash: 0 };
  const log = [];

  const accrueTo = (t) => {
    for (const [token, p] of pos) {
      if (t <= p.at) continue;
      const g = grossOn(token, p.config, p.sizeUsd, p.at, t - p.at);
      if (Number.isFinite(g)) realized += g;
      p.at = t;
    }
  };
  // Трейлинг: что позиция дала бы на горизонте H по данным ДО t. Ровно то, что видит правило.
  const trailing = (token, config, sizeUsd, t) => {
    const g = grossOn(token, config, sizeUsd, t - H, H);
    return Number.isFinite(g) ? g : 0;
  };

  const applyTarget = (tgt, t) => {
    const cur = new Map([...pos].map(([k, p]) => [k, keyOf(k, p)]));
    for (const [token, p] of pos) {
      const want = tgt.get(token);
      if (!want || keyOf(token, want) !== cur.get(token)) { pos.delete(token); tally.close += 1; }
    }
    for (const [token, want] of tgt) {
      const have = pos.get(token);
      if (have && keyOf(token, have) === keyOf(token, want)) continue;
      costs += costOn(token, want.config, want.sizeUsd);
      pos.set(token, { config: want.config, sizeUsd: want.sizeUsd, at: t });
      tally.open += 1;
    }
    // ЗАДЕЙСТВОВАННЫЙ КАПИТАЛ пишется отдельным числом, и это не украшение. Одна позиция не может
    // взять больше своего оптимума: если он $1594 при капитале $5000, то $3406 ПРОСТАИВАЮТ. Это
    // третий механизм преимущества портфеля, отдельный и от разбавления, и от выбора рынка, и без
    // этого столбца он был бы приписан им.
    let usd = 0;
    for (const [, w] of tgt) usd += w.sizeUsd;
    log.push({ t, act: "set", n: tgt.size, usd, tokens: [...tgt.keys()].join("+") });
  };

  for (const t of hours) {
    accrueTo(t);
    const ok = scan.get(t);
    const holding = pos.size > 0;

    if (mode === "hold-1" || mode === "hold-pf") {
      if (!holding) {
        const tgt = target(ok, capital, mode === "hold-1" ? 1 : kmax);
        if (tgt.size) applyTarget(tgt, t); else tally.idle += 1;
      } else tally.hold += 1;
      continue;
    }

    const tgt = target(ok, capital, mode === "rule-1" ? 1 : kmax);
    if (!holding) {
      if (tgt.size) applyTarget(tgt, t); else tally.idle += 1;
      continue;
    }

    // КРИТЕРИЙ. Общий горизонт H, переоценка в конце горизонта, поэтому стоимость ЗАКРЫТИЯ текущих
    // позиций входит в обе ветки и сокращается. Платится только ОТКРЫТИЕ того, что меняется, и
    // здесь оно оценено ПОЛНЫМ кругом: деления круга на половины измеренная модель не даёт, и
    // выдумывать его ради этого замера нельзя. Смещение известно и названо в отчёте.
    let holdGross = 0;
    for (const [token, p] of pos) holdGross += trailing(token, p.config, p.sizeUsd, t);
    let altGross = 0;
    let changeCost = 0;
    for (const [token, want] of tgt) {
      altGross += trailing(token, want.config, want.sizeUsd, t);
      const have = pos.get(token);
      if (!have || keyOf(token, have) !== keyOf(token, want)) changeCost += costOn(token, want.config, want.sizeUsd);
    }

    if (tgt.size && altGross - changeCost > holdGross && altGross - changeCost > 0) {
      applyTarget(tgt, t);
      tally.rebalances += 1;
    } else if (holdGross <= 0 && (!tgt.size || altGross - changeCost <= 0)) {
      for (const _ of pos) tally.close += 1;
      pos.clear();
      tally.cash += 1;
      log.push({ t, act: "cash" });
    } else tally.hold += 1;
  }

  accrueTo(end);
  return { mode, capital, cadence, kmax, first, end, decisions: hours.length, realized, costs, net: realized - costs, tally, log };
}
