// btcopt-hedge.test.js — golden worked-examples for the «BTC-опционы» delta-hedge engine.
// PURE math, inline crafted inputs (no fixtures). Reproduces the spec's worked numbers exactly.
// All time-dependent calls pass an explicit nowMs (never Date.now()) so the tests are deterministic.
import test from "node:test";
import assert from "node:assert/strict";
import {
  roundToStep,
  settlementBlackout,
  computeTriggers,
  expectedBenefit,
  estimateCost,
  decideHedge,
  applyFill,
} from "../src/engine/btcopt/hedge.js";

const near = (a, b, tol, label) =>
  assert.ok(Math.abs(a - b) <= tol, `${label}: got ${a}, want ${b} (+/-${tol})`);

// Base config shared by the HEDGE / SKIP / BLACKOUT worked examples.
const baseCfg = {
  deadbandBtc: 0,
  lambda: 1.25,
  priceTriggerPct: 0.5,
  takerFeeRate: 0.0005,
  slippageRate: 0,
  fundingHorizonSec: 28800,
  settlementBlackout: true,
  execStyle: "limit",
  rehedgeSec: 60,
  dailyWindowSec: 600,
  preExpirySec: 1800,
};

const NOON = Date.UTC(2026, 6, 10, 12, 0, 0); // not a blackout window
const EXPIRY_FAR = Date.UTC(2026, 6, 20, 8, 0, 0); // 10 days out
const SETTLE_0800 = Date.UTC(2026, 6, 10, 8, 0, 0); // daily settlement

test("roundToStep rounds to the exchange step (sign preserved)", () => {
  near(roundToStep(0.00123, 0.0005), 0.001, 1e-12, "0.00123→0.001");
  near(roundToStep(0.0013, 0.0005), 0.0015, 1e-12, "0.0013→0.0015");
  near(roundToStep(-0.0026, 0.001), -0.003, 1e-12, "-0.0026→-0.003");
  assert.equal(roundToStep(0.0042, 0), 0.0042, "step<=0 is a pass-through");
});

test("settlementBlackout: daily 08:00 window is active", () => {
  const r = settlementBlackout(SETTLE_0800, EXPIRY_FAR, baseCfg);
  assert.equal(r.active, true);
  assert.equal(r.reason, "settlement-0800");
});

test("settlementBlackout: 20 min past 08:00 is inactive", () => {
  const r = settlementBlackout(Date.UTC(2026, 6, 10, 8, 20, 0), EXPIRY_FAR, baseCfg);
  assert.equal(r.active, false);
  assert.equal(r.reason, null);
});

test("settlementBlackout: within preExpirySec (outside daily window) is pre-expiry", () => {
  const expiry = Date.UTC(2026, 6, 10, 8, 0, 0);
  const now = Date.UTC(2026, 6, 10, 7, 40, 0); // 20 min before expiry
  const r = settlementBlackout(now, expiry, baseCfg);
  assert.equal(r.active, true);
  assert.equal(r.reason, "pre-expiry");
});

test("settlementBlackout: mid-session (04:00) is inactive", () => {
  const r = settlementBlackout(Date.UTC(2026, 6, 10, 4, 0, 0), EXPIRY_FAR, baseCfg);
  assert.equal(r.active, false);
  assert.equal(r.reason, null);
});

test("computeTriggers: delta-only fires with the excess and reasons list", () => {
  const t = computeTriggers({
    totalDelta: -0.002,
    deadband: 0,
    underlying: 63000,
    lastHedgeUnderlying: null,
    priceTriggerPct: 0.5,
    nowMs: NOON,
    lastHedgeAt: null,
    rehedgeMs: 60000,
    createdAt: null,
  });
  near(t.deltaExcess, 0.002, 1e-12, "deltaExcess");
  assert.equal(t.deltaFired, true);
  assert.equal(t.priceFired, false);
  assert.equal(t.timeFired, false);
  assert.deepEqual(t.reasons, ["delta"]);
});

test("expectedBenefit = |deltaExcess|·underlying·m", () => {
  near(expectedBenefit({ deltaExcess: 0.002, underlying: 63000, m: 0.005 }), 0.63, 1e-9, "benefit");
});

// The golden worked numbers (taker fee + half-spread) are MARKET-branch semantics.
const mktCfg = { ...baseCfg, execStyle: "market" };

test("estimateCost (market) itemizes fee/spread/slippage/funding and sums total", () => {
  const c = estimateCost({
    hedgeQty: 0.002,
    targetQty: 0.002,
    perp: { mark: 63000, funding8h: 0, contractSize: 10 },
    liquidity: { halfSpread: 1 },
    cfg: mktCfg,
  });
  near(c.fee, 0.126, 1e-9, "fee");
  near(c.spread, 0.002, 1e-9, "spread");
  near(c.slippage, 0, 1e-9, "slippage");
  near(c.funding_horizon, 0, 1e-9, "funding_horizon");
  near(c.total, 0.128, 1e-9, "total");
});

test("estimateCost (limit): maker fee, no spread term, slippage survives as the cost floor", () => {
  const c = estimateCost({
    hedgeQty: 0.002,
    targetQty: 0.002,
    perp: { mark: 63000, funding8h: 0, contractSize: 10 },
    liquidity: { halfSpread: 1 },
    cfg: { ...baseCfg, slippageRate: 0.0002 }, // execStyle "limit" from baseCfg
  });
  near(c.fee, 0, 1e-12, "fee (maker 0.00%)");
  near(c.spread, 0, 1e-12, "spread (mid fill crosses nothing)");
  near(c.slippage, 0.002 * 63000 * 0.0002, 1e-9, "slippage (kept in both branches)");
  near(c.total, c.slippage, 1e-9, "total = slippage only");
});

test("estimateCost funding term is SIGNED: a short target receiving positive funding lowers total", () => {
  // SHORT target −0.01 BTC, positive funding 2 bps/8h over the 1-period horizon:
  // funding_horizon = −0.01·63000·0.0002 = −$0.126 — a benefit, mirroring pnl.accrueFunding where a
  // short with positive funding8h RECEIVES. Math.abs(target) would have flipped it into a phantom cost.
  const c = estimateCost({
    hedgeQty: 0.002,
    targetQty: -0.01,
    perp: { mark: 63000, funding8h: 0.0002, contractSize: 10 },
    liquidity: { halfSpread: 1 },
    cfg: mktCfg,
  });
  near(c.funding_horizon, -0.126, 1e-9, "funding_horizon (received)");
  near(c.total, 0.126 + 0.002 + 0 - 0.126, 1e-9, "total net of received funding");
  // The mirror: a LONG target paying the same rate keeps it a genuine cost.
  const l = estimateCost({
    hedgeQty: 0.002,
    targetQty: 0.01,
    perp: { mark: 63000, funding8h: 0.0002, contractSize: 10 },
    liquidity: { halfSpread: 1 },
    cfg: mktCfg,
  });
  near(l.funding_horizon, 0.126, 1e-9, "funding_horizon (paid)");
});

test("decideHedge HEDGE case — benefit clears cost·lambda", () => {
  const r = decideHedge({
    optionDelta: -0.002,
    Qperp: 0,
    snapshot: { underlying: 63000, perp: { mark: 63000, funding8h: 0, contractSize: 10 } },
    liquidity: { bid: 62999, ask: 63001, halfSpread: 1 },
    cfg: mktCfg,
    nowMs: NOON,
    expiryMs: EXPIRY_FAR,
    createdAt: null,
    lastHedgeAt: null,
    lastHedgeUnderlying: null,
    step: 0.0005,
  });
  assert.equal(r.decision, "HEDGE");
  near(r.delta_excess, 0.002, 1e-9, "delta_excess");
  near(r.estimated_benefit, 0.63, 1e-9, "estimated_benefit");
  near(r.estimated_cost.fee, 0.126, 1e-9, "estimated_cost.fee");
  near(r.estimated_cost.total, 0.128, 1e-9, "estimated_cost.total");
  assert.equal(r.hedge_order.side, "buy");
  near(r.hedge_order.amount_rounded_btc, 0.002, 1e-9, "amount_rounded_btc");
  near(r.target_futures_delta, 0.002, 1e-9, "target_futures_delta");
  assert.equal(r.hedge_order.order_type, "market");
  assert.equal(r.hedge_order.post_only, false);
  assert.deepEqual(r.trigger_reason, ["delta"]);
});

test("decideHedge (limit) — the order rides post-only and the cost model follows the branch", () => {
  const r = decideHedge({
    optionDelta: -0.002,
    Qperp: 0,
    snapshot: { underlying: 63000, perp: { mark: 63000, funding8h: 0, contractSize: 10 } },
    liquidity: { bid: 62999, ask: 63001, halfSpread: 1 },
    cfg: baseCfg, // execStyle "limit"
    nowMs: NOON,
    expiryMs: EXPIRY_FAR,
    createdAt: null,
    lastHedgeAt: null,
    lastHedgeUnderlying: null,
    step: 0.0005,
  });
  assert.equal(r.decision, "HEDGE");
  assert.equal(r.hedge_order.order_type, "limit");
  assert.equal(r.hedge_order.post_only, true);
  near(r.estimated_cost.fee, 0, 1e-12, "fee (maker)");
  near(r.estimated_cost.spread, 0, 1e-12, "spread (mid fill)");
});

test("decideHedge SKIP case — cost filter blocks the hedge", () => {
  const r = decideHedge({
    optionDelta: -0.0005,
    Qperp: 0,
    snapshot: { underlying: 63000, perp: { mark: 63000, funding8h: 0, contractSize: 10 } },
    liquidity: { bid: 62870, ask: 63130, halfSpread: 130 },
    cfg: { ...mktCfg, slippageRate: 0.001 },
    nowMs: NOON,
    expiryMs: EXPIRY_FAR,
    createdAt: null,
    lastHedgeAt: null,
    lastHedgeUnderlying: null,
    step: 0.0005,
  });
  assert.equal(r.decision, "SKIP");
  near(r.estimated_benefit, 0.1575, 1e-9, "estimated_benefit");
  near(r.estimated_cost.fee, 0.0315, 1e-9, "fee");
  near(r.estimated_cost.spread, 0.065, 1e-9, "spread");
  near(r.estimated_cost.slippage, 0.0315, 1e-9, "slippage");
  near(r.estimated_cost.total, 0.128, 1e-9, "total");
  assert.equal(r.hedge_order, null);
  // gate: 0.1575 > 0.128·1.25 = 0.16 is false
  assert.equal(r.estimated_benefit > r.estimated_cost.total * 1.25, false);
});

test("decideHedge BLACKOUT case — settlement window suppresses the hedge", () => {
  const r = decideHedge({
    optionDelta: -0.002,
    Qperp: 0,
    snapshot: { underlying: 63000, perp: { mark: 63000, funding8h: 0, contractSize: 10 } },
    liquidity: { bid: 62999, ask: 63001, halfSpread: 1 },
    cfg: baseCfg,
    nowMs: SETTLE_0800,
    expiryMs: EXPIRY_FAR,
    createdAt: null,
    lastHedgeAt: null,
    lastHedgeUnderlying: null,
    step: 0.0005,
  });
  assert.equal(r.decision, "BLACKOUT");
  assert.equal(r.hedge_order, null);
  assert.equal(r.blackout.active, true);
  assert.equal(r.blackout.reason, "settlement-0800");
  near(r.delta_excess, 0.002, 1e-9, "delta_excess");
});

test("applyFill inverse: open short then close for realized USD", () => {
  const perpState = { qty: 0, avgEntry: 0, feesCum: 0, realizedUsd: 0 };
  const meta = { contractSize: 10 };
  const cfg = { takerFeeRate: 0.0005 };

  // open short 0.002 BTC @ 63000 → round(-12.6) = -13 contracts
  const open = applyFill(perpState, { side: "sell", amount_rounded_btc: 0.002 }, 63000, meta, cfg);
  assert.equal(open.filledContracts, -13);
  assert.equal(perpState.qty, -13);
  near(perpState.avgEntry, 63000, 1e-9, "avgEntry after open");
  near(open.feeUsd, 0.065, 1e-9, "feeUsd open");
  near(open.realizedUsd, 0, 1e-9, "realizedUsd open");

  // close (buy) 0.002 BTC @ 60000 → +12 contracts, partial cover of the -13 short
  const close = applyFill(perpState, { side: "buy", amount_rounded_btc: 0.002 }, 60000, meta, cfg);
  assert.equal(close.filledContracts, 12);
  assert.equal(perpState.qty, -1);
  near(perpState.avgEntry, 63000, 1e-9, "avgEntry after partial close");
  near(close.realizedUsd, 5.714, 1e-3, "realizedUsd close");
  near(perpState.realizedUsd, 5.714, 1e-3, "cumulative realizedUsd");
});
