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

// ── Deadband scaling ────────────────────────────────────────────────────────────────────────────
// The structure size deadbandBtc is calibrated AT. Default = the engine's default qty, so the band
// a live profile actually hedges by is unchanged by the scaling below.
export const DEADBAND_REF_QTY = 0.01;

// effectiveDeadband({ deadbandBtc, structureQty, refQty }) → the ±BTC half-width to hedge by.
//
// WHY A FLAT NUMBER WAS A DEFECT, and it is subtler than "it does not scale". deadbandBtc is a band
// on the structure's DELTA, and that delta grows linearly with position size. Held flat while size
// grows, the band silently TIGHTENS in relative terms: at 5x the size it admits a fifth of the
// relative drift, so the same market produces several times the re-hedges and several times the
// fees, with nobody having asked for it.
//
// THE REAL DEFECT WAS THE MISSING ANCHOR. The number never said which size it was calibrated for,
// and the codebase disagreed with itself about the answer: the spec's worked example runs at qty 1
// (net delta −0.0019 against a 0.001 band, so the band is about half the delta), while the shipped
// default is qty 0.01 (the $100 paper deposit). Same number, two meanings, differing by 100x. Making
// the anchor an explicit setting is the fix; choosing a different anchor is a CALIBRATION decision
// and is deliberately left to the operator, not smuggled in here.
//
// Scaling is LINEAR in size for the same reason the delta is: holding band/delta constant keeps the
// hedge's relative tightness (and therefore its cost) invariant to how much capital is deployed.
// A missing or non-positive size falls back to the raw setting rather than guessing.
export function effectiveDeadband({ deadbandBtc, structureQty, refQty = DEADBAND_REF_QTY } = {}) {
  if (!(deadbandBtc >= 0)) return 0;
  if (!(structureQty > 0) || !(refQty > 0)) return deadbandBtc;
  return deadbandBtc * (structureQty / refQty);
}

// The price move fraction the benefit estimate is tuned to protect against.
//
// SEPARATE KNOB, AND ITS ABSENCE WAS A DEFECT. Until 2026-08-13 expectedBenefit read
// cfg.priceTriggerPct for this, so ONE number meant two unrelated things: the threshold at which
// the price trigger fires, and the size of the move the benefit is measured against. They could
// neither be tuned apart nor even MEASURED apart (a parity run isolating the benefit filter had to
// arm the price trigger with it). benefitMovePct now carries the modelling assumption; the fallback
// to priceTriggerPct preserves the behaviour of any profile written before the split.
export function benefitMoveFrac(cfg) {
  const pct = cfg?.benefitMovePct ?? cfg?.priceTriggerPct;
  return Number.isFinite(pct) ? pct / 100 : 0;
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

// Itemized $ cost of the hedge, execution-style aware (mirrors the fill semantics in engine.js):
// market — fee is round-trip (2x taker) on the traded size and the half-spread is paid; limit
// (post-only) — maker rate (Deribit BTC-perp 0.00%) and NO spread term (the fill models mid).
// slippage stays in BOTH branches as a non-zero cost floor: a real resting order still carries
// non-fill / adverse-selection risk, and a zero total would degenerate the λ filter. funding_horizon
// is the expected funding carried on the *target* futures position over cfg.fundingHorizonSec
// (normalized to the 8h funding period) — SIGNED: a long target (δ>0) pays positive funding (a
// cost), a short target RECEIVES it (negative cost) — the cost-side view of pnl.accrueFunding's
// −qty·… convention. total is the plain sum and may therefore be reduced by favorable funding.
export function estimateCost({ hedgeQty, targetQty, perp, liquidity, cfg }) {
  const limit = cfg.execStyle === "limit";
  const feeRate = limit ? cfg.makerFeeRate ?? 0 : cfg.takerFeeRate;
  const fee = 2 * Math.abs(hedgeQty) * perp.mark * feeRate;
  const spread = limit ? 0 : Math.abs(hedgeQty) * liquidity.halfSpread;
  const slippage = Math.abs(hedgeQty) * perp.mark * cfg.slippageRate;
  const funding_horizon =
    targetQty * perp.mark * perp.funding8h * (cfg.fundingHorizonSec / 28800);
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
  structureQty,
}) {
  const totalDelta = optionDelta + Qperp;
  const target = -optionDelta;
  // Полоса масштабируется размером структуры (см. effectiveDeadband). При дефолтном qty 0.01 она
  // равна настройке в точности, поэтому дефолтная конфигурация не меняется.
  const deadband = effectiveDeadband({ deadbandBtc: cfg.deadbandBtc, structureQty, refQty: cfg.deadbandRefQty });
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
      deadband_btc: deadband,
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
    // ФАКТИЧЕСКАЯ полоса, по которой принято это решение: она масштабируется размером структуры,
    // и показывать вместо неё настройку значило бы врать в UI ровно там, где решение объясняется.
    deadband_btc: deadband,
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
    m: benefitMoveFrac(cfg), // собственный knob, а не порог ценового триггера (см. benefitMoveFrac)
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
  // Fee rate follows the ORDER's execution style (not cfg.execStyle): flatten orders are always
  // order_type "market" (taker) even when the structure hedges with post-only limits.
  const feeRate = hedge_order.order_type === "limit" ? cfg.makerFeeRate ?? 0 : cfg.takerFeeRate;
  const feeUsd = Math.abs(contractsDelta) * cs * feeRate;
  perpState.feesCum = (perpState.feesCum || 0) + feeUsd;

  return { filledContracts: contractsDelta, priceRef, feeUsd, realizedUsd: realized };
}
