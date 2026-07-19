// economics.js — «OTM-сканер» экономика сделки (S1, план §5.7, решение А5). PURE.
// Принцип расслоения (аудит письма Дмитрия): ГЕЙТ — только факты (комиссии, спред, лоты,
// глубина — объективно вычислимы из тикера, книги и тарифов); модельные оценки — только
// аналитика с подписанными допущениями, вход они не решают никогда. Этот модуль — единый
// источник издержек и для У14 сканера, и для издержкового гейта выходов Strategy Two (S4),
// по тому же закону, что SCAN_PRESETS (пороги входа и выхода не могут разъехаться).
//
// Единицы: линейные BTC_USDC-опционы, цены в USD за 1.0 BTC контракта, lot = min_trade_amount
// (0.01). Комиссия за контракт = min(feeRate × индекс, кэп% × премия) — ставки верифицированы
// S0 (§4.4): maker == taker == 0.0003 доли индекса, кэп 12.5% премии. Доля издержек от премии
// от количества НЕ зависит — поэтому невыгодность сделки есть свойство рынка, не депозита.

import { OPTION_FEE_RATE, OPTION_FEE_CAP_PCT_PREMIUM } from "./presets.js";

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;

// Комиссия одной стороны (вход ИЛИ выход) в % премии. Кэп биндится, когда тарифная комиссия
// от индекса превышает кэп% от премии (дешёвые дальние OTM — обычный случай).
//   feeUsd = min(feeRate·index, cap/100·mark) за 1.0 контракта; feePct = feeUsd/mark·100.
export function optionFeePct({ markUsd, indexPrice, feeRate = OPTION_FEE_RATE, feeCapPctPrem = OPTION_FEE_CAP_PCT_PREMIUM } = {}) {
  if (!posNum(markUsd) || !posNum(indexPrice)) return { feePct: null, feeUsd: null, capped: null };
  const rateUsd = feeRate * indexPrice;
  const capUsd = (feeCapPctPrem / 100) * markUsd;
  const feeUsd = Math.min(rateUsd, capUsd);
  return { feePct: (feeUsd / markUsd) * 100, feeUsd, capped: capUsd < rateUsd };
}

// Издержки round-trip покупки опциона в % премии (факты для У14, план §5.7).
//   Спред: halfSpread = (ask − bid)/2; выход — ВСЕГДА пересечение (выходы триггерные,
//   реалистично тейкерские); вход — 0 в maker-mid, halfSpread в taker-cross.
//   Выходная комиссия оценивается по ТЕКУЩЕМУ mark (фактический mark выхода неизвестен) —
//   это подписанная оценка, S4/S5 пересчитают её на реальном выходе.
// null при отсутствии bid/ask/mark/index — У14 честно уйдёт в unknown.
export function computeTradeCosts({ markUsd, bidUsd, askUsd, indexPrice, execModel = "maker-mid", feeRate, feeCapPctPrem } = {}) {
  if (!posNum(markUsd) || !posNum(indexPrice) || !fin(bidUsd) || !fin(askUsd) || askUsd < bidUsd || bidUsd < 0) {
    return null;
  }
  const fee = optionFeePct({ markUsd, indexPrice, feeRate, feeCapPctPrem });
  if (fee.feePct == null) return null;
  const halfSpreadPct = (((askUsd - bidUsd) / 2) / markUsd) * 100;
  const spreadEntryPct = execModel === "taker-cross" ? halfSpreadPct : 0;
  const spreadExitPct = halfSpreadPct;
  const roundTripCostPct = fee.feePct * 2 + spreadEntryPct + spreadExitPct;
  return {
    execModel,
    feeEntryPct: fee.feePct,
    feeExitPct: fee.feePct,
    feeUsdPerContract: fee.feeUsd,
    feeCapped: fee.capped,
    halfSpreadPct,
    spreadEntryPct,
    spreadExitPct,
    roundTripCostPct,
  };
}

// Брейк-эвены и капитал-метрики (план §5.7). Модельная часть (breakEvenMoveSigma) — дельта-
// приближение первого порядка, в UI подписывается как оценка; гейтом не является.
//   breakEvenMarkPct  — на сколько % должен вырасти mark, чтобы выйти в ноль (= roundTripCostPct);
//   breakEvenMoveSigma ≈ (breakEven$ / (|delta|·S)) / σ1d — «окупается при движении ≈X σ»;
//   minCapitalUsd     — депозит, при котором мин-лот не ломает риск-дисциплину;
//   comfortCapitalUsd — то же × maxConcurrent.
export function computeEconomics({ costs, markUsd, deltaAbs, indexPrice, sigma1dPct, lot, riskPerTradePct, maxConcurrent } = {}) {
  const rt = costs?.roundTripCostPct;
  const breakEvenMarkPct = fin(rt) ? rt : null;
  let breakEvenMoveSigma = null;
  if (fin(rt) && posNum(markUsd) && posNum(deltaAbs) && posNum(indexPrice) && posNum(sigma1dPct)) {
    const breakEvenUsd = (rt / 100) * markUsd;
    breakEvenMoveSigma = (breakEvenUsd / (deltaAbs * indexPrice)) / (sigma1dPct / 100);
  }
  let minCapitalUsd = null;
  let comfortCapitalUsd = null;
  if (posNum(markUsd) && posNum(lot) && posNum(riskPerTradePct)) {
    minCapitalUsd = (markUsd * lot * 100) / riskPerTradePct;
    if (posNum(maxConcurrent)) comfortCapitalUsd = minCapitalUsd * maxConcurrent;
  }
  return { breakEvenMarkPct, breakEvenMoveSigma, minCapitalUsd, comfortCapitalUsd };
}

// Фактический риск после лот-округления в % депозита — гранулярность видима, не замалчивается.
export function riskActualPct({ qty, markUsd, equityUsd } = {}) {
  return fin(qty) && qty >= 0 && posNum(markUsd) && posNum(equityUsd) ? ((qty * markUsd) / equityUsd) * 100 : null;
}

// Кэп размера от видимой глубины стороны входа (А5): у покупок опционов ликвидность ограничивает
// БОЛЬШОЙ капитал, а не маленький. Бюджет = maxQtyDepthPct% от depthUsd стороны входа (для
// покупки — ask-сторона); qty режется вниз до лот-сетки. null при неизвестной глубине.
export function qtyMaxByDepth({ entryDepthUsd, maxQtyDepthPct, markUsd, lot } = {}) {
  if (!fin(entryDepthUsd) || entryDepthUsd < 0 || !posNum(maxQtyDepthPct) || !posNum(markUsd) || !posNum(lot)) {
    return { depthBudgetUsd: null, qtyMaxDepth: null };
  }
  const depthBudgetUsd = (maxQtyDepthPct / 100) * entryDepthUsd;
  const qtyMaxDepth = Math.floor(depthBudgetUsd / markUsd / lot + 1e-9) * lot;
  return { depthBudgetUsd, qtyMaxDepth: Math.max(0, qtyMaxDepth) };
}
