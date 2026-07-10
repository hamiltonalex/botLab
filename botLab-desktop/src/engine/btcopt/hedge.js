// hedge.js — «BTC-опционы» (Strategy One) delta-hedge decision engine.
// PURE: no electron / DOM / fs / fetch — deterministic and unit-testable. Every time-dependent
// function takes an explicit `nowMs` (never Date.now()) so the caller owns the clock and tests
// are reproducible.
//
// The 4-leg options structure carries an aggregate delta (optionDelta, in BTC). A BTC perpetual
// leg (Qperp, signed BTC) is traded to keep the book near delta-neutral. This module decides
// WHETHER to re-hedge (delta / price / time triggers gated by a benefit-vs-cost filter), sizes
// the perp order, and — on fill — updates the inverse-perp position state (P&L in USD).
//
// Units: deltas are BTC; perp fills are quoted in BTC then converted to Deribit $10 inverse
// contracts. Costs/benefits/realized-P&L are USD.

// Round a raw BTC quantity to the exchange step (e.g. minTradeAmount). Sign is preserved by
// Math.round; step<=0 is a pass-through (no rounding).
export function roundToStep(x, step) {
  return step > 0 ? Math.round(x / step) * step : x;
}

// Settlement / expiry blackout window. Hedging pauses around the daily 08:00 UTC settlement and
// in the final minutes before an expiry (thin books, settlement prints — hedges there are noise).
//   secOfDay via the (%+%)% idiom so a negative nowMs still maps into [0,86400).
//   dailyActive:  within ±dailyWindowSec of 08:00 UTC (28800s).
//   preActive:    expiry is in the future and within preExpirySec.
export function settlementBlackout(nowMs, expiryMs, cfg) {
  const secOfDay = (((nowMs / 1000) % 86400) + 86400) % 86400;
  const dailyActive = Math.abs(secOfDay - 28800) <= cfg.dailyWindowSec;
  const preActive =
    expiryMs != null && expiryMs - nowMs >= 0 && expiryMs - nowMs <= cfg.preExpirySec * 1000;
  const active = dailyActive || preActive;
  const reason = dailyActive ? "settlement-0800" : preActive ? "pre-expiry" : null;
  return { active, reason };
}

// Which re-hedge triggers are armed this cycle. Any one firing is enough to consider a hedge (the
// benefit/cost filter still has the final say). `deltaExcess` is how far |totalDelta| pokes past
// the deadband; `timeFired` measures from the last hedge (or, before the first hedge, createdAt).
export function computeTriggers({
  totalDelta,
  deadband,
  underlying,
  lastHedgeUnderlying,
  priceTriggerPct,
  nowMs,
  lastHedgeAt,
  rehedgeMs,
  createdAt,
}) {
  const deltaExcess = Math.max(0, Math.abs(totalDelta) - deadband);
  const deltaFired = deltaExcess > 0;
  const priceMovePct = lastHedgeUnderlying
    ? (100 * Math.abs(underlying - lastHedgeUnderlying)) / lastHedgeUnderlying
    : 0;
  const priceFired = priceMovePct >= priceTriggerPct;
  const timeFired = nowMs - (lastHedgeAt ?? createdAt ?? nowMs) >= rehedgeMs;
  const reasons = [];
  if (deltaFired) reasons.push("delta");
  if (priceFired) reasons.push("price");
  if (timeFired) reasons.push("time");
  return { deltaFired, priceFired, timeFired, reasons, deltaExcess, priceMovePct };
}

// Expected $ benefit of re-hedging: the delta we would neutralize (BTC beyond the deadband) times
// the underlying times m (the price-move fraction the trigger is tuned to protect against).
export function expectedBenefit({ deltaExcess, underlying, m }) {
  return Math.abs(deltaExcess) * underlying * m;
}

// Itemized $ cost of the hedge. fee is round-trip (2x taker) on the traded size; spread is the
// half-spread paid on the traded size; slippage scales with mark; funding_horizon is the expected
// funding carried on the *target* futures position over cfg.fundingHorizonSec (normalized to the
// 8h funding period). total is the plain sum.
export function estimateCost({ hedgeQty, targetQty, perp, liquidity, cfg }) {
  const fee = 2 * Math.abs(hedgeQty) * perp.mark * cfg.takerFeeRate;
  const spread = Math.abs(hedgeQty) * liquidity.halfSpread;
  const slippage = Math.abs(hedgeQty) * perp.mark * cfg.slippageRate;
  const funding_horizon =
    Math.abs(targetQty) * perp.mark * perp.funding8h * (cfg.fundingHorizonSec / 28800);
  const total = fee + spread + slippage + funding_horizon;
  return { fee, spread, slippage, funding_horizon, total };
}

// The hedge decision for one evaluation cycle. Returns one of HEDGE / SKIP / BLACKOUT with the
// supporting numbers. `optionDelta` is the structure's aggregate delta (BTC); `Qperp` is the
// current perp delta (BTC). The target futures delta is −optionDelta (fully neutralize options).
export function decideHedge({
  optionDelta,
  Qperp,
  snapshot,
  liquidity,
  cfg,
  nowMs,
  expiryMs,
  createdAt,
  lastHedgeAt,
  lastHedgeUnderlying,
  step,
}) {
  const totalDelta = optionDelta + Qperp;
  const target = -optionDelta;
  const deadband = cfg.deadbandBtc;
  const blackout = settlementBlackout(nowMs, expiryMs, cfg);

  // (1) blackout gate — do not hedge into settlement / the pre-expiry window.
  if (cfg.settlementBlackout && blackout.active) {
    return {
      decision: "BLACKOUT",
      trigger_reason: [],
      estimated_cost: null,
      estimated_benefit: 0,
      hedge_order: null,
      target_futures_delta: target,
      delta_excess: Math.max(0, Math.abs(totalDelta) - deadband),
      blackout,
    };
  }

  // (2) which triggers are armed
  const t = computeTriggers({
    totalDelta,
    deadband,
    underlying: snapshot.underlying,
    lastHedgeUnderlying,
    priceTriggerPct: cfg.priceTriggerPct,
    nowMs,
    lastHedgeAt,
    rehedgeMs: cfg.rehedgeSec * 1000,
    createdAt,
  });
  const delta_excess = t.deltaExcess;
  const base = {
    trigger_reason: t.reasons,
    target_futures_delta: target,
    delta_excess,
    blackout,
  };

  // (3) nothing fired — stand pat
  if (t.reasons.length === 0) {
    return { decision: "SKIP", estimated_cost: null, estimated_benefit: 0, hedge_order: null, ...base };
  }

  // (4) size the perp order to the residual delta, rounded to the exchange step
  const raw = -optionDelta - Qperp;
  const hedgeQty = roundToStep(raw, step);
  if (hedgeQty === 0) {
    return { decision: "SKIP", estimated_cost: null, estimated_benefit: 0, hedge_order: null, ...base };
  }

  // (5) benefit vs itemized cost
  const estimated_benefit = expectedBenefit({
    deltaExcess: delta_excess,
    underlying: snapshot.underlying,
    m: cfg.priceTriggerPct / 100,
  });
  const estimated_cost = estimateCost({
    hedgeQty,
    targetQty: target,
    perp: snapshot.perp,
    liquidity,
    cfg,
  });

  // (6) trade only if the benefit clears cost·lambda
  if (estimated_benefit > estimated_cost.total * cfg.lambda) {
    return {
      decision: "HEDGE",
      estimated_cost,
      estimated_benefit,
      hedge_order: {
        side: hedgeQty > 0 ? "buy" : "sell",
        amount_btc: Math.abs(raw),
        amount_rounded_btc: Math.abs(hedgeQty),
        order_type: cfg.execStyle,
        post_only: cfg.execStyle === "limit",
      },
      ...base,
    };
  }
  return { decision: "SKIP", estimated_cost, estimated_benefit, hedge_order: null, ...base };
}

// Apply a (paper) perp fill to perpState, inverse-contract aware. Converts the BTC order size to
// signed $10 contracts at priceRef, then either grows the position (weighted-average entry) or
// reduces/flips it (booking inverse realized USD = closedSigned·cs·(priceRef−avgEntry)/avgEntry).
// Mutates perpState in place and returns this fill's summary.
export function applyFill(perpState, hedge_order, priceRef, meta, cfg) {
  const cs = meta.contractSize;
  const signedBtc = (hedge_order.side === "buy" ? 1 : -1) * hedge_order.amount_rounded_btc;
  const contractsDelta = Math.round((signedBtc * priceRef) / cs); // BTC → $10 contracts

  const qty = perpState.qty;
  let realized = 0;
  if (qty === 0 || Math.sign(contractsDelta) === Math.sign(qty)) {
    // opening or adding in the same direction — blend the entry
    const absQty = Math.abs(qty);
    const absAdd = Math.abs(contractsDelta);
    const denom = absQty + absAdd;
    if (denom > 0) {
      perpState.avgEntry = (absQty * perpState.avgEntry + absAdd * priceRef) / denom;
    }
  } else {
    // reducing or flipping — realize P&L on the closed contracts (inverse: USD per contract)
    const closing = Math.min(Math.abs(contractsDelta), Math.abs(qty));
    const closedSigned = Math.sign(qty) * closing;
    realized = (closedSigned * cs * (priceRef - perpState.avgEntry)) / perpState.avgEntry;
    if (Math.abs(contractsDelta) > Math.abs(qty)) perpState.avgEntry = priceRef; // flipped through 0
  }

  perpState.qty += contractsDelta;
  if (perpState.qty === 0) perpState.avgEntry = 0;
  perpState.realizedUsd = (perpState.realizedUsd || 0) + realized;
  const feeUsd = Math.abs(contractsDelta) * cs * cfg.takerFeeRate;
  perpState.feesCum = (perpState.feesCum || 0) + feeUsd;

  return { filledContracts: contractsDelta, priceRef, feeUsd, realizedUsd: realized };
}
