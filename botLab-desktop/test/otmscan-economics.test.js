// otmscan-economics.test.js — S1 (А5, план §5.7/§11): кэп комиссии биндится/не биндится,
// обе execModel, breakeven, minCapital, riskActual после округления, qtyMaxDepth.

import test from "node:test";
import assert from "node:assert/strict";
import {
  optionFeePct,
  computeTradeCosts,
  computeEconomics,
  riskActualPct,
  qtyMaxByDepth,
} from "../src/engine/otmscan/economics.js";
import { near } from "./otmscan-helpers.mjs";

const S = 100000; // тарифная комиссия 0.0003·S = $30 за контракт

test("комиссия: кэп 12.5% премии биндится на дешёвом опционе, не биндится на дорогом", () => {
  const cheap = optionFeePct({ markUsd: 200, indexPrice: S }); // тариф 30 против кэпа 25
  near(cheap.feeUsd, 25, 1e-9, "кэп связал");
  near(cheap.feePct, 12.5, 1e-9, "12.5% премии");
  assert.equal(cheap.capped, true);
  const rich = optionFeePct({ markUsd: 400, indexPrice: S }); // тариф 30 против кэпа 50
  near(rich.feeUsd, 30, 1e-9, "тарифная");
  near(rich.feePct, 7.5, 1e-9, "7.5% премии");
  assert.equal(rich.capped, false);
});

test("round-trip maker-mid: вход без пересечения спреда, выход всегда тейкерский", () => {
  const c = computeTradeCosts({ markUsd: 350, bidUsd: 345, askUsd: 355, indexPrice: S, execModel: "maker-mid" });
  near(c.feeEntryPct, 30 / 3.5, 1e-9, "комиссия входа %"); // 8.571%
  near(c.spreadEntryPct, 0, 1e-12, "мейкер-вход без спреда");
  near(c.spreadExitPct, 5 / 3.5, 1e-9, "полуспред выхода"); // 1.429%
  near(c.roundTripCostPct, (2 * 30 + 5) / 3.5, 1e-9, "итого 18.571%");
});

test("round-trip taker-cross: разница моделей — ровно полуспред входа (комиссия одинакова)", () => {
  const mk = (execModel) => computeTradeCosts({ markUsd: 350, bidUsd: 345, askUsd: 355, indexPrice: S, execModel });
  const diff = mk("taker-cross").roundTripCostPct - mk("maker-mid").roundTripCostPct;
  near(diff, 5 / 3.5, 1e-9, "дельта = halfSpread/mark");
});

test("издержки: null без bid/ask и при перевёрнутой книге — У14 уйдёт в unknown", () => {
  assert.equal(computeTradeCosts({ markUsd: 350, bidUsd: null, askUsd: 355, indexPrice: S }), null);
  assert.equal(computeTradeCosts({ markUsd: 350, bidUsd: 360, askUsd: 355, indexPrice: S }), null);
  assert.equal(computeTradeCosts({ markUsd: 0, bidUsd: 0, askUsd: 1, indexPrice: S }), null);
});

test("breakeven: рост марка = roundTrip; движение спота в σ1d — дельта-приближение", () => {
  const costs = computeTradeCosts({ markUsd: 350, bidUsd: 345, askUsd: 355, indexPrice: S, execModel: "maker-mid" });
  const e = computeEconomics({ costs, markUsd: 350, deltaAbs: 0.25, indexPrice: S, sigma1dPct: 2, lot: 0.01, riskPerTradePct: 20, maxConcurrent: 2 });
  near(e.breakEvenMarkPct, costs.roundTripCostPct, 1e-12, "breakeven = издержки");
  // breakEven$ = 18.571%·350 = 65; ΔS = 65/0.25 = 260; 0.26% спота / 2% = 0.13σ
  near(e.breakEvenMoveSigma, 0.13, 1e-3, "≈0.13σ");
});

test("minCapital: премия мин-лота через риск-долю; comfort умножает на maxConcurrent", () => {
  const e = computeEconomics({ costs: null, markUsd: 350, deltaAbs: null, indexPrice: S, sigma1dPct: null, lot: 0.01, riskPerTradePct: 20, maxConcurrent: 2 });
  near(e.minCapitalUsd, 17.5, 1e-9, "3.5·100/20");
  near(e.comfortCapitalUsd, 35, 1e-9, "×2");
  assert.equal(e.breakEvenMarkPct, null);
  assert.equal(e.breakEvenMoveSigma, null);
});

test("riskActualPct: фактическая доля депозита после лот-округления", () => {
  near(riskActualPct({ qty: 0.05, markUsd: 350, equityUsd: 100 }), 17.5, 1e-9, "0.05·350/100");
  assert.equal(riskActualPct({ qty: null, markUsd: 350, equityUsd: 100 }), null);
});

test("qtyMaxByDepth: бюджет — доля ask-глубины, размер режется вниз до лот-сетки", () => {
  const d = qtyMaxByDepth({ entryDepthUsd: 8000, maxQtyDepthPct: 25, markUsd: 350, lot: 0.01 });
  near(d.depthBudgetUsd, 2000, 1e-9, "25% от 8000");
  near(d.qtyMaxDepth, 5.71, 1e-9, "floor(2000/350/0.01)·0.01");
  const thin = qtyMaxByDepth({ entryDepthUsd: 10, maxQtyDepthPct: 25, markUsd: 350, lot: 0.01 });
  near(thin.qtyMaxDepth, 0, 1e-12, "тоньше лота — ноль");
  assert.equal(qtyMaxByDepth({ entryDepthUsd: null, maxQtyDepthPct: 25, markUsd: 350, lot: 0.01 }).qtyMaxDepth, null);
});
