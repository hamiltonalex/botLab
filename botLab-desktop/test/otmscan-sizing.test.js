// otmscan-sizing.test.js — S1 (план §5.3/§11): бюджет риска, лот-гранулярность, кэп qtyMax,
// кэп глубины (А5), честные отказы min_lot_exceeds_risk / min_lot_exceeds_depth.

import test from "node:test";
import assert from "node:assert/strict";
import { computeSizing } from "../src/engine/otmscan/scan-engine.js";
import { near } from "./otmscan-helpers.mjs";

const BASE = { markUsd: 350, lot: 0.01, equityUsd: 100, riskPerTradePct: 20, qtyMax: 0.05 };

test("бюджет: floor(riskBudget / премия лота) в лотах, кэп qtyMax", () => {
  const s = computeSizing(BASE);
  assert.equal(s.ok, true);
  near(s.riskBudgetUsd, 20, 1e-9, "20% от $100");
  near(s.lotPremUsd, 3.5, 1e-9, "премия лота");
  near(s.qtySuggested, 0.05, 1e-12, "floor(20/3.5)=5 лотов, ровно qtyMax");
  const capped = computeSizing({ ...BASE, qtyMax: 0.03 });
  near(capped.qtySuggested, 0.03, 1e-12, "кэп qtyMax");
});

test("лот-сетка: qty всегда кратен лоту (float-гигиена)", () => {
  const s = computeSizing({ ...BASE, markUsd: 333, qtyMax: 10 }); // 20/3.33 = 6.006 лотов
  near(s.qtySuggested, 0.06, 1e-12, "6 лотов");
  assert.equal(Math.round(s.qtySuggested * 100) % 1, 0);
});

test("min_lot_exceeds_risk: премия мин-лота больше бюджета — блок, не тихое округление вверх", () => {
  const s = computeSizing({ ...BASE, markUsd: 2500 }); // лот $25 > бюджет $20
  assert.equal(s.ok, false);
  assert.equal(s.blockReason, "min_lot_exceeds_risk");
  assert.equal(s.qtySuggested, null);
  near(s.lotPremUsd, 25, 1e-9, "число для «нужно от $X» даёт economics.minCapitalUsd");
});

test("кэп глубины: qty режется до доли ask-глубины; блок при глубине тоньше лота", () => {
  const s = computeSizing({ ...BASE, entryDepthUsd: 50, maxQtyDepthPct: 25 }); // бюджет $12.5 → 3 лота
  assert.equal(s.ok, true);
  near(s.qtySuggested, 0.03, 1e-12, "floor(12.5/3.5)=3 лота");
  assert.equal(s.depthCapped, true);
  near(s.qtyBudget, 0.05, 1e-12, "бюджетный размер до кэпа — порог У12 xPremium");
  const thin = computeSizing({ ...BASE, entryDepthUsd: 10, maxQtyDepthPct: 25 }); // $2.5 < лот $3.5
  assert.equal(thin.ok, false);
  assert.equal(thin.blockReason, "min_lot_exceeds_depth");
});

test("глубина неизвестна — кэп не применяется (У12 сам гейтит книгу)", () => {
  const s = computeSizing({ ...BASE, entryDepthUsd: null, maxQtyDepthPct: 25 });
  assert.equal(s.ok, true);
  near(s.qtySuggested, 0.05, 1e-12, "без кэпа");
  assert.equal(s.depthCapped, false);
  assert.equal(s.qtyMaxDepth, null);
});

test("нет данных для размера: mark/лот/депозит отсутствуют — единый честный отказ", () => {
  for (const bad of [{ markUsd: null }, { lot: null }, { equityUsd: 0 }, { riskPerTradePct: null }]) {
    const s = computeSizing({ ...BASE, ...bad });
    assert.equal(s.ok, false);
    assert.equal(s.blockReason, "нет данных для размера");
  }
});
