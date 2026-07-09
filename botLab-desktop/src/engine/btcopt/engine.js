// engine.js — «BTC-опционы» (Dmitri Marinkin Strategy One) paper engine CORE.
// PURE: no electron / DOM / fs / fetch — deterministic, unit-testable. Isolated from the
// funding-arb engine (paper.js/ledger.js are carry-accrual only; options P&L is mark-to-market).
//
// Phase 0: create() / defaultSettings() only — a persist-round-trippable skeleton state.
// Phase 1 adds ingest(snapshot) + evaluate() -> cycle-snapshot (the hedge engine + P&L attribution).
//
// The strategy: a 4-leg BTC options "winged straddle" (long ATM call + long ATM put + short OTM call
// + short OTM put) delta-hedged with a BTC perpetual. Greeks come FROM Deribit (public/ticker);
// this module never prices options itself except (later) the theoretical payoff curve.

export const BOT_ID = "btc-options";
export const SCHEMA_VERSION = 1;

// Default engine/strategy settings (spec defaults). Persisted to <BOT_ID>-settings.json.
// Ranges (clamped at use, Phase 1): deadband 0.0005..0.003, priceTrigger 0.5..1.0, reprice 0.25..5s,
// lambda 1.0..2.0, wing offset 10..15%.
export function defaultSettings() {
  return {
    deadbandPreset: "normal", // aggressive | normal | conservative
    deadbandBtc: 0.001, // ±BTC (normal preset)
    priceTriggerPct: 0.5, // % move since last hedge that arms the price trigger
    rehedgeSec: 60, // time-trigger interval (a prompt to re-price, not a must-trade)
    lambda: 1.25, // hedge cost multiplier (gate: benefit > cost * lambda)
    repriceSec: 3, // Deribit poll cadence (0.25..5s)
    callOffsetPct: 10, // short call strike ~ spot * (1 + off)
    putOffsetPct: 10, // short put  strike ~ spot * (1 - off)
    qty: 0.1, // option contracts per leg (validated vs min_trade_amount at open)
    execStyle: "limit", // limit (post-only) | market
    settlementBlackout: true, // pause hedging at 08:00 UTC settlement + last 30 min before expiry
    testnet: false, // public data source: prod (www.deribit.com) vs test.deribit.com
  };
}

// The persisted paper state — must round-trip cleanly through JSON.stringify/parse.
export function create(params) {
  params = params || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    botId: BOT_ID,
    createdAt: params.nowMs ?? null, // stamped by the caller (no Date.now() in a pure module)
    settings: { ...defaultSettings(), ...(params.settings || {}) },
    structure: null, // the open 4-leg structure (set by openStructure() in Phase 1)
    perpState: { qty: 0, avgEntry: 0, feesCum: 0, fundingCum: 0 }, // BTC-perp hedge leg (paper)
    ledger: [], // cumulative hedge/accrual events — independent of any exchange session reset
    metrics: {}, // run metrics (Phase 2)
  };
}
