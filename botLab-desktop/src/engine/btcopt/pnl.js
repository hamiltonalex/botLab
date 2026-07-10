// pnl.js — «BTC-опционы» (Strategy One) P&L attribution CORE.
// PURE: no fetch / fs / DOM / Date.now — deterministic, unit-testable. Isolated from the
// funding-arb engine. Two very different legs are marked with two very different conventions:
//
//   • OPTIONS are LINEAR USDC instruments — marks are quoted directly in USD premium, so leg
//     P&L is qtySigned·(mark − entryMark)·contractSize with NO ×index term.
//   • The HEDGE is an INVERSE BTC perpetual ($10/contract) — margin & PnL are denominated in BTC,
//     so PnL per contract is contractSize·(1/avgEntry − 1/mark) BTC, and a SHORT (qty<0) that pays
//     a POSITIVE funding rate RECEIVES cash. Getting these two signs right is the whole point.
//
// Everything here is a pure function of (state, snapshot); accrueFunding is the only mutator and it
// only touches perpState.fundingCum, exactly as documented.

// ── Options structure (LINEAR USDC — marks already in USD) ──────────────────────────────────────
// markStructure(structure, snapshot) → { upl_usd, byLeg:[{ instrument, upl_usd, value_usd }] }.
// Per leg: currentMark = snapshot.legs[instrument]?.mark ?? entryMark (fall back to open mark when the
// leg is missing from this snapshot), upl = qtySigned·(currentMark − entryMark)·contractSize,
// value_usd = qtySigned·currentMark·contractSize. Σ upl → upl_usd.
export function markStructure(structure, snapshot) {
  const legs = structure?.legs ?? [];
  const marks = snapshot?.legs ?? {};
  let upl_usd = 0;
  const byLeg = [];
  for (const leg of legs) {
    const cs = leg.contractSize ?? 1;
    const currentMark = marks[leg.instrument]?.mark ?? leg.entryMark;
    const upl = leg.qtySigned * (currentMark - leg.entryMark) * cs;
    const value_usd = leg.qtySigned * currentMark * cs;
    upl_usd += upl;
    byLeg.push({ instrument: leg.instrument, upl_usd: upl, value_usd });
  }
  return { upl_usd, byLeg };
}

// ── Inverse perpetual hedge (BTC-denominated PnL) ───────────────────────────────────────────────
// markPerp(perpState, perp) → { futuresDeltaBtc, upl_usd, upl_btc, notionalUsd }.
// Flat / unpriced (qty===0 || avgEntry<=0) → all zeros. Otherwise (INVERSE math):
//   futuresDeltaBtc = qty·contractSize / mark              (BTC delta the futures leg carries now)
//   upl_btc         = qty·contractSize·(1/avgEntry − 1/mark)
//   upl_usd         = upl_btc·mark = qty·contractSize·(mark − avgEntry)/avgEntry
//   notionalUsd     = |qty|·contractSize                   (USD face; $10 per contract)
export function markPerp(perpState, perp) {
  const qty = perpState?.qty ?? 0;
  const avgEntry = perpState?.avgEntry ?? 0;
  if (qty === 0 || avgEntry <= 0) {
    return { futuresDeltaBtc: 0, upl_usd: 0, upl_btc: 0, notionalUsd: 0 };
  }
  const cs = perp.contractSize;
  const futuresDeltaBtc = (qty * cs) / perp.mark;
  const upl_btc = qty * cs * (1 / avgEntry - 1 / perp.mark);
  const upl_usd = upl_btc * perp.mark;
  const notionalUsd = Math.abs(qty) * cs;
  return { futuresDeltaBtc, upl_usd, upl_btc, notionalUsd };
}

// ── Funding accrual (mutates perpState.fundingCum) ──────────────────────────────────────────────
// accrueFunding(perpState, perp, dtSec, { maxDtSec }) → { deltaUsd, gapSkippedSec }.
// dtEff = min(dtSec, maxDtSec); deltaUsd = −qty·contractSize·funding8h·(dtEff/28800). A SHORT
// (qty<0) with positive funding8h RECEIVES → positive deltaUsd. fundingCum is accumulated in place;
// gapSkippedSec = max(0, dtSec − maxDtSec) reports time dropped by the anti-catch-up clamp.
export function accrueFunding(perpState, perp, dtSec, opts = {}) {
  const maxDtSec = opts.maxDtSec ?? Infinity;
  const dtEff = Math.min(dtSec, maxDtSec);
  const deltaUsd = -perpState.qty * perp.contractSize * perp.funding8h * (dtEff / 28800);
  perpState.fundingCum = (perpState.fundingCum || 0) + deltaUsd;
  const gapSkippedSec = Math.max(0, dtSec - maxDtSec);
  return { deltaUsd, gapSkippedSec };
}

// ── Full attribution ────────────────────────────────────────────────────────────────────────────
// attribute(engineState, snapshot) → { options_upl, futures_upl, fees_total, funding_total,
//   net_total, vs_no_hedge }. futures_upl folds realized PnL into the live inverse mark; net nets
//   fees out; vs_no_hedge is the hedge program's net contribution vs. holding the options naked
//   (Phase-2a replaces this with a true shadow book).
export function attribute(engineState, snapshot) {
  const { structure, perpState } = engineState;
  // Realized option P&L from already-closed structures survives close (cumulative, not session-reset);
  // the live open structure's mark-to-market is added on top.
  const openMtm = structure ? markStructure(structure, snapshot).upl_usd : 0;
  const options_upl = (engineState.realizedOptionsUsd || 0) + openMtm;
  const futures_upl = (perpState.realizedUsd || 0) + markPerp(perpState, snapshot.perp).upl_usd;
  const funding_total = perpState.fundingCum || 0;
  const fees_total = perpState.feesCum || 0;
  const net_total = options_upl + futures_upl + funding_total - fees_total;
  const vs_no_hedge = net_total - options_upl;
  return { options_upl, futures_upl, fees_total, funding_total, net_total, vs_no_hedge };
}

// ── No-hedge shadow book (Phase 2a) ───────────────────────────────────────────────────────────────
// noHedgeAttribute(engineState, snapshot) → the SAME 6-key attribution shape for a SHADOW book holding
// the identical option structure but with NO perp hedge (perpQty ≡ 0). Because option MtM is independent
// of the hedge and markPerp short-circuits to zero for a flat perp, net_total ≡ options_upl — the true
// "options-only, after-costs" comparison that pnl.vs_no_hedge only proxied. Pure; re-uses attribute() on
// a zeroed-perp overlay (no second engine), so it reconciles by construction.
export function noHedgeAttribute(engineState, snapshot) {
  const shadow = {
    structure: engineState.structure,
    realizedOptionsUsd: engineState.realizedOptionsUsd || 0,
    perpState: { qty: 0, avgEntry: 0, feesCum: 0, fundingCum: 0, realizedUsd: 0 },
  };
  return attribute(shadow, snapshot);
}

// ── Ledger append (sequenced, numeric-safe) ─────────────────────────────────────────────────────
// appendLedger(engineState, event) → assigns seq = ledger.length+1, pushes a normalized event with
// every numeric field defaulted to 0 (so downstream sums never see undefined), returns the stored row.
export function appendLedger(engineState, event = {}) {
  const stored = {
    seq: engineState.ledger.length + 1,
    t: event.t ?? 0,
    type: event.type ?? null,
    side: event.side ?? null,
    contracts: event.contracts ?? 0,
    priceRef: event.priceRef ?? 0,
    deltaBtc: event.deltaBtc ?? 0,
    feeUsd: event.feeUsd ?? 0,
    fundingUsd: event.fundingUsd ?? 0,
    realizedUsd: event.realizedUsd ?? 0,
    note: event.note ?? null,
  };
  engineState.ledger.push(stored);
  return stored;
}

// ── Reconciliation ──────────────────────────────────────────────────────────────────────────────
// ledgerReconciles(engineState, snapshot) → { ok, identityDelta, feesDelta, realizedDelta,
//   fundingDelta }. Checks the attribution identity closes AND that the running perpState accumulators
//   equal the independent sums of the ledger rows. ok = every delta < 1e-6·max(1, |net_total|).
export function ledgerReconciles(engineState, snapshot) {
  const a = attribute(engineState, snapshot);
  const identityDelta = Math.abs(
    a.net_total - (a.options_upl + a.futures_upl + a.funding_total - a.fees_total),
  );
  const ledger = engineState.ledger ?? [];
  const sum = (key) => ledger.reduce((acc, e) => acc + (e[key] || 0), 0);
  const perpState = engineState.perpState;
  const feesDelta = Math.abs(sum("feeUsd") - (perpState.feesCum || 0));
  const realizedDelta = Math.abs(sum("realizedUsd") - (perpState.realizedUsd || 0));
  const fundingDelta = Math.abs(sum("fundingUsd") - (perpState.fundingCum || 0));
  const tol = 1e-6 * Math.max(1, Math.abs(a.net_total));
  const ok = identityDelta < tol && feesDelta < tol && realizedDelta < tol && fundingDelta < tol;
  return { ok, identityDelta, feesDelta, realizedDelta, fundingDelta };
}
