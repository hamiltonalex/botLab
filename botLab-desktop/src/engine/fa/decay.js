// decay.js - НАБЛЮДЕНИЕ ЗАТУХАНИЯ ФАНДИНГА GMX У ОТКРЫТОЙ СДЕЛКИ. PURE: ни сети, ни файлов, ни Date.now.
//
// ЧТО ЭТО И ЧЕМ НЕ ЯВЛЯЕТСЯ. Наблюдение для карточки честности, а не решение и не сторож: правило
// выхода и сторожа этих чисел не видят, кода отказа здесь нет и реестры автомата не растут. Решение
// владельца 2026-09-05 после замера З7 (`scripts/funding-arb-study/exit-7-decay.mjs`): закрытие по
// затуханию на трёх периодах истории проигрывает правилу кругами, а видеть затухание на экране надо.
//
// МЕХАНИЗМ, КОТОРЫЙ ЗДЕСЬ НАБЛЮДАЕТСЯ. Адаптивный фандинг GMX v2: платит большая сторона; когда
// открытый интерес получающей стороны становится больше встречного, множитель фандинга убывает
// линейно с постоянным шагом (`fundingDecreaseFactorPerSecond`) до нуля, а затем растёт против
// прежнего получателя. Живой эпизод BTC/B 04-05.09.2026: ставка длинной стороны падала ровно на
// 1.6e-10/с каждый час, 25 часов подряд, до нуля по тренду и дальше вниз.
//
// ЧТО СЧИТАЕТСЯ, по часовым строкам кадра и живому снимку, для ставки СВОЕЙ стороны сделки
// (f_long у длинной ноги GMX, f_short у короткой; положительная ставка означает, что платят нам):
//   runHours      - сколько последних часов подряд ставка строго убывала: шаг ровно час, дыра в
//                   строках или плато обрывают ряд; живой снимок ниже последней строки продлевает
//                   ряд на текущий час (`liveContinues`);
//   stepPerHour   - средний шаг ряда по строкам кадра (/с за час), отрицательный; нужен ряд не короче
//                   двух шагов, иначе тренда нет;
//   fNow          - ставка сейчас: живой снимок, если он есть, иначе последняя строка;
//   hoursToZero, zeroAtMs - пересечение нуля по тренду при fNow > 0 и шаге < 0;
//   belowZeroHours - сколько последних строк подряд ставка <= 0 (фандинг GMX платим мы);
//   skewFrac      - перекос интереса по живому снимку: (своя база - встречная) / (сумма); больше нуля
//                   значит своя сторона больше, то есть адаптивный фандинг ведёт ставку вниз.
// Статус: `flipped` (ставка <= 0), `declining` (ряд убывания не пуст), `none`, `unknown` (ставки нет).
// Разбавление не учитывается: на знак и на ряд оно не влияет.
//
// ЧЕГО МОДУЛЬ НЕ ИМПОРТИРУЕТ: ничего из `src/engine/btcopt/`. Замыкания импортов ботов пересекаются
// по пустому множеству, и это стережёт тест.

import { SEC_PER_HOUR, HOURS_PER_YEAR } from "../math.js";

const SEC_PER_YEAR = SEC_PER_HOUR * HOURS_PER_YEAR;
const fin = Number.isFinite;

export const FA_DECAY_STATUSES = Object.freeze(["unknown", "none", "declining", "flipped"]);

export function decayObservation({ rows = null, gmxSide = "long", live = null, liveAtMs = null, nowMs = null } = {}) {
  const side = gmxSide === "short" ? "short" : "long";
  const fKey = side === "short" ? "f_short" : "f_long";
  const ownKey = side === "short" ? "fbase_short" : "fbase_long";
  const otherKey = side === "short" ? "fbase_long" : "fbase_short";
  const base = {
    side, status: "unknown", known: false,
    fNow: null, fNowAtMs: null, aprNow: null,
    runHours: 0, stepPerHour: null, stepAprPerHour: null,
    hoursToZero: null, zeroAtMs: null, belowZeroHours: 0,
    skewFrac: null, liveContinues: null, rowsUsed: 0, lastRowTsHour: null,
  };
  const list = (rows || []).filter((r) => r && fin(r.tsHour) && fin(r[fKey]));
  const liveF = live && fin(live[fKey]) ? live[fKey] : null;
  if (!list.length && liveF == null) return base;

  // Ряд строго убывающих часовых шагов, заканчивающийся последней строкой.
  let run = 0;
  for (let i = list.length - 1; i >= 1; i -= 1) {
    const a = list[i];
    const b = list[i - 1];
    if (a.tsHour - b.tsHour !== SEC_PER_HOUR || !(a[fKey] < b[fKey])) break;
    run += 1;
  }
  const last = list.length ? list[list.length - 1] : null;
  const step = last && run >= 2 ? (last[fKey] - list[list.length - 1 - run][fKey]) / run : null;
  let below = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i][fKey] <= 0) below += 1; else break;
  }
  const liveContinues = liveF != null && last ? liveF < last[fKey] : null;
  const runHours = run + (liveContinues ? 1 : 0);
  const fNow = liveF != null ? liveF : last[fKey];
  const fNowAtMs = liveF != null
    ? (fin(liveAtMs) ? liveAtMs : (fin(nowMs) ? nowMs : null))
    : (last.tsHour + SEC_PER_HOUR) * 1000;
  let hoursToZero = null;
  let zeroAtMs = null;
  if (fNow > 0 && step != null && step < 0) {
    hoursToZero = fNow / -step;
    zeroAtMs = fin(fNowAtMs) ? fNowAtMs + hoursToZero * SEC_PER_HOUR * 1000 : null;
  }
  let skewFrac = null;
  if (live && fin(live[ownKey]) && fin(live[otherKey]) && live[ownKey] > 0 && live[otherKey] > 0) {
    skewFrac = (live[ownKey] - live[otherKey]) / (live[ownKey] + live[otherKey]);
  }
  const status = fNow <= 0 ? "flipped" : runHours >= 1 ? "declining" : "none";
  return {
    ...base, status, known: true,
    fNow, fNowAtMs, aprNow: fNow * SEC_PER_YEAR,
    runHours, stepPerHour: step, stepAprPerHour: step == null ? null : step * SEC_PER_YEAR,
    hoursToZero, zeroAtMs, belowZeroHours: below,
    skewFrac, liveContinues, rowsUsed: list.length, lastRowTsHour: last ? last.tsHour : null,
  };
}

// Строка для журнала и тестов. Образец `explainDrawdown`.
export function explainDecay(v) {
  if (!v || !v.known) return "затухание: ставки своей стороны нет";
  const apr = `${(v.aprNow * 100).toFixed(2)}% годовых`;
  if (v.status === "flipped") return `ставка своей стороны ${apr}, платим мы, ниже нуля ${v.belowZeroHours} ч`;
  if (v.status === "declining") {
    const zero = fin(v.hoursToZero) ? `, ноль по тренду через ${v.hoursToZero.toFixed(1)} ч` : "";
    return `ставка своей стороны ${apr}, убывает ${v.runHours} ч подряд${zero}`;
  }
  return `ставка своей стороны ${apr}, ряда убывания нет`;
}
