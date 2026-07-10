// engine.js — «BTC-опционы» (Dmitri Marinkin Strategy One) paper engine CORE.
// PURE: no electron / DOM / fs / fetch — deterministic, unit-testable. Isolated from the
// funding-arb engine (paper.js/ledger.js are carry-accrual only; options P&L is mark-to-market).
//
// The strategy: a 4-leg BTC options "winged straddle" (long ATM call + long ATM put + short OTM call
// + short OTM put), one expiry, delta-hedged with a BTC perpetual. Greeks come FROM Deribit
// (public/ticker); this module never prices options itself. The option legs are LINEAR USDC
// (BTC_USDC-*, marks in USD); the hedge leg is the INVERSE BTC-PERPETUAL ($10 contract) — the perp's
// inverse mark-to-market / funding is localized to hedge.js/pnl.js.
//
// This module composes the pure sub-modules into the tick lifecycle:
//   ingest(state, snapshot, nowMs)   — accrue funding on the held perp; stamp clocks.
//   evaluate(state, snapshot, nowMs) — net greeks + hedge decision + (paper) fill + P&L → the cycle-snapshot.
//   openStructure / closeStructure   — manual entry / exit.
//   account                          — paper equity/margin estimate.
// All time-dependent behaviour takes an explicit nowMs (never Date.now()) so tests are reproducible.

import { buildStructure, optionDeltaTotal, netGreeks, netDebit, pickExpiry, structureRejections } from "./structure.js";
import { payoffCurve } from "./payoff.js";
import { decideHedge, applyFill, settlementBlackout } from "./hedge.js";
import { markStructure, markPerp, accrueFunding, attribute, noHedgeAttribute, appendLedger } from "./pnl.js";
import { initMetrics, foldCycle, summarize } from "./metrics.js";
import { structureMargin } from "./margin.js";
import { computeScenarios } from "./stress.js";
import { computeRegime } from "./regime.js";

export const BOT_ID = "btc-options";
export const SCHEMA_VERSION = 1;

// Cost-model rates + blackout windows the hedge engine needs but that aren't user-facing knobs. Merged
// under the persisted settings at evaluate time (settings win if they ever override one).
const HEDGE_CONSTANTS = {
  takerFeeRate: 0.0005, // 5 bps taker (Deribit illustrative)
  slippageRate: 0.0002, // flat slippage rate on the perp mark
  fundingHorizonSec: 28800, // one 8h funding period
  dailyWindowSec: 600, // ±10 min around 08:00 UTC settlement
  preExpirySec: 1800, // last 30 min before expiry
  fundingMaxGapSec: 300, // anti-catch-up clamp for a sleep/wake gap
};

// Merge the persisted user settings over the engine cost constants → the cfg the hedge engine consumes.
function buildCfg(settings) {
  return { ...HEDGE_CONSTANTS, ...(settings || {}) };
}

// Default engine/strategy settings (spec defaults). Persisted to <BOT_ID>-settings.json.
// qty default is the linear-USDC option minimum (0.01) — right-sized for the $100 paper deposit.
export function defaultSettings() {
  return {
    deadbandPreset: "normal", // aggressive | normal | conservative
    deadbandBtc: 0.001, // ±BTC (normal preset)
    priceTriggerPct: 0.5, // % move since last hedge that arms the price trigger
    rehedgeSec: 60, // time-trigger interval (a prompt to re-price, not a must-trade)
    lambda: 1.25, // hedge cost multiplier (gate: benefit > cost * lambda)
    repriceSec: 3, // Deribit poll cadence (source owns the timer)
    callOffsetPct: 10, // short call strike ~ spot * (1 + off)
    putOffsetPct: 10, // short put  strike ~ spot * (1 - off)
    qty: 0.01, // option contracts per leg (Deribit BTC_USDC min lot = 0.01; validated at open)
    execStyle: "limit", // limit (post-only) | market
    settlementBlackout: true, // pause hedging at 08:00 UTC settlement + last 30 min before expiry
    testnet: false, // public data source: prod (www.deribit.com) vs test.deribit.com
    paperEquityUsd: 100, // starting paper deposit (USD); equity = this + cumulative net P&L
    marginAlertPct: 0.8, // alert when maintenance-margin utilisation ≥ this fraction of equity (Phase 2c)
    ivWindowSec: 86400, // IV-regime rolling window (Phase 3b) — rank ATM IV within the last 24h
    ivEntryMaxRank: 0.35, // entry favorable when IV-rank ≤ this (long-vol thesis: enter when IV is LOW)
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
    structure: null, // the open 4-leg structure (set by openStructure())
    perpState: { qty: 0, avgEntry: 0, feesCum: 0, fundingCum: 0, realizedUsd: 0 }, // inverse BTC-perp hedge (qty in $10 contracts)
    realizedOptionsUsd: 0, // option MtM locked in by closed structures (cumulative)
    ledger: [], // cumulative hedge/accrual/open/close events — independent of any exchange session reset
    lastHedgeAt: null, // ms of the last executed hedge (time/price trigger baseline)
    lastHedgeUnderlying: null, // BTC price at the last hedge (price trigger baseline)
    lastIngestAt: null, // ms of the last ingest (funding-accrual dt baseline)
    lastUnderlying: null, // last seen BTC price
    metrics: initMetrics(), // run-metrics accumulators (Phase 2b) — O(1) scalars, reset at each structure open
  };
}

// Reconciliation/risk monitor only (never drives hedging): Deribit's account delta_total ≈
// Σ qᵢ·(BS δᵢ − mark_in_BTC) + futures. For linear USDC options mark is USD → convert at the index.
function exchangeDeltaTotal(structure, snapshot, Qperp) {
  if (!structure) return Qperp;
  const idx = snapshot.index || snapshot.underlying || 0;
  let ntd = 0;
  for (const l of structure.legs) {
    const g = snapshot.legs?.[l.instrument];
    if (!g) continue;
    const markBtc = l.markInUsd && idx ? (g.mark ?? 0) / idx : g.mark ?? 0;
    ntd += l.qtySigned * ((g.delta ?? 0) - markBtc);
  }
  return ntd + Qperp;
}

// ── Ingest: accrue funding on a held perp, refresh clocks. Called once per market tick before evaluate.
export function ingest(state, snapshot, nowMs) {
  const cfg = buildCfg(state.settings);
  if (state.perpState.qty !== 0 && snapshot.perp && Number.isFinite(snapshot.perp.funding8h)) {
    const last = state.lastIngestAt ?? nowMs;
    const dtSec = Math.max(0, (nowMs - last) / 1000);
    if (dtSec > 0) accrueFunding(state.perpState, snapshot.perp, dtSec, { maxDtSec: cfg.fundingMaxGapSec });
  }
  state.lastIngestAt = nowMs;
  state.lastUnderlying = snapshot.underlying;
  return state;
}

// ── Evaluate: the full per-cycle computation → the §5 cycle-snapshot (drives the whole view).
// Recomputes net greeks, runs the hedge decision, executes a paper fill on HEDGE, and attributes P&L.
export function evaluate(state, snapshot, nowMs) {
  const structure = state.structure;
  // Engine params are FROZEN at structure open (the running structure hedges by the params it was
  // opened with; the live toolbar settings only drive the Zone-Ⅰ hypothesis until the next open).
  const cfg = buildCfg(structure?.engineCfg ?? state.settings);
  const perp = snapshot.perp || null;
  const gateOk = snapshot.fresh?.gateOk !== false;

  const optionDelta = structure ? optionDeltaTotal(structure, snapshot) : 0;
  const greeks = structure ? netGreeks(structure, snapshot) : { delta: 0, gamma: 0, vega: 0, theta: 0 };
  const mp = markPerp(state.perpState, perp || {});
  const Qperp = mp.futuresDeltaBtc;
  const totalDelta = optionDelta + Qperp;
  const liquidity = snapshot.liquidity || { bid: perp?.bid ?? null, ask: perp?.ask ?? null, halfSpread: 0 };
  const step = perp && perp.mark ? perp.contractSize / perp.mark : 0; // BTC per $10 contract

  // Hedge decision. Only run when a structure is open, the perp is priced, and the greeks gate is OK;
  // otherwise stand pat (a degraded snapshot must never trigger a trade on bad data).
  let decision;
  if (structure && perp && step > 0 && gateOk) {
    decision = decideHedge({
      optionDelta,
      Qperp,
      snapshot,
      liquidity,
      cfg,
      nowMs,
      expiryMs: structure.expiryMs,
      createdAt: structure.createdAt,
      lastHedgeAt: state.lastHedgeAt,
      lastHedgeUnderlying: state.lastHedgeUnderlying,
      step,
    });
  } else {
    decision = {
      decision: "SKIP",
      trigger_reason: [],
      estimated_cost: null,
      estimated_benefit: 0,
      hedge_order: null,
      target_futures_delta: -optionDelta,
      delta_excess: Math.max(0, Math.abs(totalDelta) - cfg.deadbandBtc),
      blackout: { active: false, reason: null },
    };
  }

  // ── Cycle fields are a PRE-fill decision snapshot: the spec's sample cycle-JSON reports
  // current_futures_delta as the pre-hedge value, then the hedge takes visible effect next tick.
  // Capture the pre-fill position, price-move and P&L now; the fill is applied below as a side-effect.
  const perp_position = {
    contracts: state.perpState.qty,
    btc: Qperp,
    avgEntry: state.perpState.avgEntry,
    notionalUsd: mp.notionalUsd,
    upl_usd: mp.upl_usd,
  };
  const priceMovePct =
    state.lastHedgeUnderlying && Number.isFinite(snapshot.underlying)
      ? (100 * Math.abs(snapshot.underlying - state.lastHedgeUnderlying)) / state.lastHedgeUnderlying
      : 0;
  const pnl = attribute(state, snapshot);
  const acct = account(state, snapshot);

  // ── Hedge vs no-hedge (Phase 2a): a real shadow book (perpQty ≡ 0) run in parallel. Its net is the
  // options-only, after-costs outcome; hedge_contribution is the hedge program's true net contribution
  // (perp realized + funding − perp fees) — positive means hedging helped after costs, negative means it
  // only cost money (a common outcome on tiny size). Derived, stored nowhere, appends no ledger row.
  const shadow = noHedgeAttribute(state, snapshot);
  const hedgeContribution = pnl.net_total - shadow.net_total;
  const hedge_vs = {
    hedged_net: pnl.net_total,
    no_hedge_net: shadow.net_total,
    hedge_contribution: hedgeContribution,
    components: { futures_upl: pnl.futures_upl, funding_total: pnl.funding_total, perp_fees: pnl.fees_total },
    helped: hedgeContribution > 0,
  };

  const option_legs = structure
    ? structure.legs.map((l) => {
        const g = snapshot.legs?.[l.instrument] || {};
        const mark = g.mark ?? l.entryMark ?? null;
        return {
          instrument: l.instrument,
          type: l.type,
          side: l.side,
          strike: l.strike,
          qty: l.qtySigned,
          bid: g.bid ?? null,
          ask: g.ask ?? null,
          mark,
          mark_iv: g.markIv ?? null,
          delta: g.delta ?? null,
          gamma: g.gamma ?? null,
          vega: g.vega ?? null,
          theta: g.theta ?? null,
          delta_contrib: l.qtySigned * (g.delta ?? 0),
          value_usd: l.qtySigned * (mark ?? 0) * l.contractSize,
        };
      })
    : [];

  const payoff =
    structure && Number.isFinite(snapshot.underlying)
      ? payoffCurve(structure, { min: snapshot.underlying * 0.75, max: snapshot.underlying * 1.25, n: 96 })
      : null;

  // ── Side-effect: execute the paper fill on HEDGE (takes effect next tick), book it, advance clocks.
  if (decision.decision === "HEDGE" && decision.hedge_order && perp) {
    const priceRef = decision.hedge_order.side === "buy" ? liquidity.ask ?? perp.mark : liquidity.bid ?? perp.mark;
    const fill = applyFill(state.perpState, decision.hedge_order, priceRef, perp, cfg);
    state.lastHedgeAt = nowMs;
    state.lastHedgeUnderlying = snapshot.underlying;
    appendLedger(state, {
      t: nowMs,
      type: "hedge",
      side: decision.hedge_order.side,
      contracts: fill.filledContracts,
      priceRef,
      deltaBtc: (decision.hedge_order.side === "buy" ? 1 : -1) * decision.hedge_order.amount_rounded_btc,
      feeUsd: fill.feeUsd,
      realizedUsd: fill.realizedUsd,
      note: decision.trigger_reason.join("+"),
    });
  }

  // The last executed hedge (decision panel's "последний хедж") — derived from the ledger AFTER the
  // fill, so it reflects this tick's hedge even though the position fields above are pre-fill.
  const lastHedgeEv = [...state.ledger].reverse().find((e) => e.type === "hedge");
  const lastHedge = lastHedgeEv
    ? { seq: lastHedgeEv.seq, t: lastHedgeEv.t, side: lastHedgeEv.side, amount_rounded_btc: Math.abs(lastHedgeEv.deltaBtc), priceRef: lastHedgeEv.priceRef, realizedUsd: lastHedgeEv.realizedUsd }
    : null;

  // ── Run metrics (Phase 2b): fold this reprice cycle into the O(1) accumulators. Only while a
  // structure is open (idle flat ticks would dilute Sharpe/hit-rate). maintUtil is wired in 2c.
  if (typeof state.metrics?.n !== "number") state.metrics = initMetrics(); // forward-migrate old {} state
  if (structure) {
    foldCycle(state.metrics, {
      net: pnl.net_total,
      totalDelta,
      decision: decision.decision,
      hedgeSizeBtc: decision.hedge_order?.amount_rounded_btc ?? 0,
      feesCum: state.perpState.feesCum,
      fundingCum: state.perpState.fundingCum,
      maintUtil: acct.maintenance_utilisation,
    });
  }

  // ── Stress scenarios (Phase 2d): pure what-if from net greeks + payoff geometry. Deterministic.
  const stress = structure
    ? { scenarios: computeScenarios(structure, snapshot, greeks, state.perpState, cfg) }
    : { scenarios: [] };

  // ── IV regime (Phase 3b): the entry signal, computed from the caller-attached IV history — the ring
  // lives in the MAIN process (snapshot.ivContext), never in this persisted state (O(1)-per-tick law).
  // LIVE settings, not the frozen engineCfg: entry advice must follow the CURRENT knobs even while an
  // old structure still runs — and the signal matters most while FLAT (structure == null).
  let iv_regime = null;
  if (snapshot.ivContext && Array.isArray(snapshot.ivContext.series)) {
    const liveCfg = buildCfg(state.settings);
    iv_regime = computeRegime(snapshot.ivContext.series, { nowMs, cfg: liveCfg });
    // The same ranking applied to the DVOL series: its history is backfilled 24–48h from the public
    // volatility-index endpoint, so this rank is meaningful from the first minutes of a session while
    // the ATM window is still filling. Context only — `favorable` stays ATM-driven.
    iv_regime.dvol_rank = computeRegime(
      snapshot.ivContext.series.map((e) => ({ ts: e.ts, atmIv: e.dvol })),
      { nowMs, cfg: liveCfg },
    ).iv_rank;
  }

  return {
    ts: snapshot.ts ?? nowMs,
    underlying_price: snapshot.underlying ?? null,
    index_price: snapshot.index ?? null,
    structure_id: structure?.id ?? null,
    option_legs,
    net_option_delta_bs: optionDelta,
    net_gamma: greeks.gamma,
    net_vega: greeks.vega,
    net_theta: greeks.theta,
    net_debit: structure?.entryDebitUsd ?? 0,
    current_net_value_usd: structure ? netDebit(structure, snapshot).debitUsd : 0,
    total_delta_bs: totalDelta,
    current_futures_delta: Qperp,
    perp_position,
    exchange_delta_total: exchangeDeltaTotal(structure, snapshot, Qperp),
    target_futures_delta: decision.target_futures_delta,
    hedge_deadband_btc: cfg.deadbandBtc,
    delta_excess: decision.delta_excess,
    price_move_since_last_hedge_pct: priceMovePct,
    trigger_reason: decision.trigger_reason,
    estimated_cost: decision.estimated_cost,
    estimated_benefit: decision.estimated_benefit,
    decision: decision.decision,
    hedge_order: decision.hedge_order,
    last_hedge: lastHedge,
    account: acct,
    pnl,
    hedge_vs,
    metrics: summarize(state.metrics),
    stress,
    iv_regime,
    blackout: decision.blackout ?? { active: false, reason: null },
    gate: { ok: gateOk, reason: gateOk ? null : "greeks-missing" },
    payoff,
    fresh: snapshot.fresh ?? null,
  };
}

// ── Pre-trade check (Phase 3a): the structured go/no-go for opening THIS structure at THIS moment.
// Composes the pure structure checks (min lot / lot step / expiry coherence — "block"), the settlement
// blackout at the open moment ("block"; PDF p.14 "invalid due to … settlement state" — skipped when the
// user disabled the blackout), and the real Deribit IM vs paper equity ("warn" — user decision: surfaced
// with real numbers, opening still allowed; consistent with 2c's over_deposit honesty).
export function preTradeCheck(state, structure, metaByInstrument, snapshot, nowMs) {
  const cfg = buildCfg(state.settings);
  const rejections = [...structureRejections(structure, metaByInstrument)];
  if (cfg.settlementBlackout !== false) {
    const b = settlementBlackout(nowMs, structure.expiryMs, cfg);
    if (b.active)
      rejections.push({
        code: "settlement",
        severity: "block",
        detail:
          b.reason === "pre-expiry"
            ? "<30 мин до экспирации — открытие в блэкаут запрещено"
            : "окно расчёта 08:00 UTC — открытие в блэкаут запрещено",
      });
  }
  const equity = (cfg.paperEquityUsd ?? 100) + attribute(state, snapshot).net_total;
  const im = structureMargin(structure, snapshot).initial;
  if (im > equity)
    rejections.push({
      code: "margin",
      severity: "warn",
      detail: `IM $${Math.round(im)} > депозит $${Math.round(equity)} — структура не помещается в депозит`,
    });
  return rejections;
}

// ── Open a structure (manual or auto). Auto-construction (Phase 3a): expiry == null ⇒ the engine picks
// the nearest live expiry itself (≤3d, skipping any already inside the pre-expiry blackout — opening into
// delta decay is never right). Gated by preTradeCheck; "warn" rejections ride along in the OK response.
export function openStructure(state, params, chain, snapshot, nowMs) {
  if (params && params.expiry == null) {
    const cfg = buildCfg(state.settings);
    const exp = pickExpiry(chain, nowMs, { minLeadMs: (cfg.preExpirySec ?? 1800) * 1000 });
    if (exp == null) return { error: "нет живых экспираций ≤3д — авто-подбор невозможен" };
    params = { ...params, expiry: exp };
  }
  const built = buildStructure(params, chain, snapshot);
  if (built.error) return built;

  const metas = Array.isArray(chain) ? chain : chain?.instruments ?? [];
  const metaByInstrument = {};
  for (const l of built.legs) metaByInstrument[l.instrument] = metas.find((m) => m.instrument_name === l.instrument);
  const rejections = preTradeCheck(state, built, metaByInstrument, snapshot, nowMs);
  const blocks = rejections.filter((r) => r.severity === "block");
  if (blocks.length) return { error: blocks.map((r) => r.detail).join("; "), rejections };

  built.id = `s1-${built.expiryMs}-${built.strikes.atm}-${nowMs}`;
  built.createdAt = nowMs;
  built.engineCfg = { ...state.settings }; // freeze the engine params at open (read-only while running)
  state.structure = built;
  state.lastHedgeAt = null; // reset the hedge clock to structure open
  state.lastHedgeUnderlying = snapshot.underlying ?? null;
  state.metrics = initMetrics(); // run metrics scope to THIS structure's run (Phase 2b)
  appendLedger(state, {
    t: nowMs,
    type: "open",
    priceRef: snapshot.underlying ?? 0,
    note: `winged straddle Kp${built.strikes.kp}/K${built.strikes.atm}/Kc${built.strikes.kc} · x${built.legs[0].qtyAbs}`,
  });
  return { ok: true, structure: built, rejections };
}

// ── Close the structure: flatten the perp (realize inverse P&L), lock in the option MtM, keep the
// cumulative P&L (realizedOptionsUsd survives, so net P&L is not reset by closing).
export function closeStructure(state, snapshot, nowMs) {
  if (!state.structure) return { error: "нет открытой структуры" };
  const cfg = buildCfg(state.settings);
  const perp = snapshot.perp || null;

  if (state.perpState.qty !== 0 && perp && perp.mark) {
    const closeBtc = (-state.perpState.qty * perp.contractSize) / perp.mark; // BTC to bring perp → flat
    const side = closeBtc > 0 ? "buy" : "sell";
    const order = { side, amount_btc: Math.abs(closeBtc), amount_rounded_btc: Math.abs(closeBtc), order_type: "market", post_only: false };
    const priceRef = side === "buy" ? snapshot.liquidity?.ask ?? perp.mark : snapshot.liquidity?.bid ?? perp.mark;
    const fill = applyFill(state.perpState, order, priceRef, perp, cfg);
    appendLedger(state, { t: nowMs, type: "close-perp", side, contracts: fill.filledContracts, priceRef, feeUsd: fill.feeUsd, realizedUsd: fill.realizedUsd });
  }

  const optMtm = markStructure(state.structure, snapshot).upl_usd;
  state.realizedOptionsUsd = (state.realizedOptionsUsd || 0) + optMtm;
  appendLedger(state, { t: nowMs, type: "close-options", realizedUsd: optMtm, note: `closed ${state.structure.id}` });

  state.structure = null;
  state.lastHedgeAt = null;
  state.lastHedgeUnderlying = null;
  return { ok: true };
}

// ── Paper account estimate. Equity = deposit + cumulative net P&L. Margin (Phase 2c) is the REAL Deribit
// Standard-Margin requirement of the SHORT option legs (linear/USDC formulas, per-leg sum, no netting) —
// replacing the Phase-1 debit proxy. On tiny size vs a $100 deposit the min-size straddle's initial margin
// can EXCEED the deposit; that is surfaced honestly (over_deposit + the utilisation figures), not gated.
// margin_alert keys on MAINTENANCE utilisation (the liquidation-relevant figure), not initial.
export function account(state, snapshot) {
  const cfg = buildCfg(state.settings);
  const pnl = attribute(state, snapshot);
  const equity = (cfg.paperEquityUsd ?? 100) + pnl.net_total;
  const m = state.structure ? structureMargin(state.structure, snapshot) : { initial: 0, maintenance: 0 };
  const denom = Math.max(1e-9, equity);
  const initial_utilisation = m.initial / denom;
  const maintenance_utilisation = m.maintenance / denom;
  return {
    equity,
    margin_balance: equity,
    initial_margin: m.initial,
    maintenance_margin: m.maintenance,
    initial_utilisation,
    maintenance_utilisation,
    worst_utilisation: Math.max(maintenance_utilisation, state.metrics?.worstMaintUtil ?? 0),
    over_deposit: m.initial > equity,
    margin_alert: maintenance_utilisation >= (cfg.marginAlertPct ?? 0.8),
  };
}
