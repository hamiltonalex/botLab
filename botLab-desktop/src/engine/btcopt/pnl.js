// pnl.js - «BTC-опционы» (Strategy One) P&L attribution CORE.
// PURE: no fetch / fs / DOM / Date.now - deterministic, unit-testable. Isolated from the
// funding-arb engine. Two very different legs are marked with two very different conventions:
//
//   • OPTIONS are LINEAR USDC instruments - marks are quoted directly in USD premium, so leg
//     P&L is qtySigned·(mark − entryMark)·contractSize with NO ×index term.
//   • The HEDGE is an INVERSE BTC perpetual ($10/contract) - margin & PnL are denominated in BTC,
//     so PnL per contract is contractSize·(1/avgEntry − 1/mark) BTC, and a SHORT (qty<0) that pays
//     a POSITIVE funding rate RECEIVES cash. Getting these two signs right is the whole point.
//
// Everything here is a pure function of (state, snapshot); accrueFunding is the only mutator and it
// only touches perpState.fundingCum, exactly as documented.

import { intrinsicAt, intrinsicOfLegs } from "./payoff.js";

// ── Options structure (LINEAR USDC - marks already in USD) ──────────────────────────────────────
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
// markPerp(perpState, perp) → { futuresDeltaBtc, futuresNotionalBtc, upl_usd, upl_btc, notionalUsd }.
// Flat / unpriced (qty===0 || avgEntry<=0, либо перп снимка без mark/contractSize) → all zeros.
// Otherwise (INVERSE math):
//   futuresDeltaBtc    = qty·contractSize / avgEntry       (USD-PnL delta, see below)
//   futuresNotionalBtc = qty·contractSize / mark           (BTC face at the CURRENT price)
//   upl_btc            = qty·contractSize·(1/avgEntry − 1/mark)
//   upl_usd            = upl_btc·mark = qty·contractSize·(mark − avgEntry)/avgEntry
//   notionalUsd        = |qty|·contractSize                (USD face; $10 per contract)
//
// TWO NUMBERS, NOT ONE, AND CONFLATING THEM COST REAL EXPOSURE. Until 2026-08-13 this function
// returned only qty·cs/mark and called it the delta. That is the BTC FACE of the position, and it
// is the right answer to "how much BTC am I carrying", and the wrong answer to "how does my USD
// PnL move when spot moves". The second answer follows directly from the upl_usd line above:
//   upl_usd = qty·cs·(mark − avgEntry)/avgEntry  ⇒  ∂upl_usd/∂mark = qty·cs/avgEntry = CONSTANT.
// The two differ by exactly mark/avgEntry, i.e. by how far price has travelled from the position's
// average entry. Feeding the face into the delta-neutrality test (engine.js) silently re-introduced
// a directional bet: precisely the exposure the hedge exists to remove.
//
// MEASURED, NOT ARGUED (scripts/parity-sellhedge.mjs, 5 years of record, 2.5 bps hedge cost): the
// face-as-delta variant returned ×13.20 against the reference ×10.24 (BETTER), while over the
// falling year 2025-08..2026-08 it returned ×1.22 against ×1.28 (WORSE). An effect whose sign
// tracks market direction is a directional bet, and the five-year gain was a bull-sample artefact.
//
// WHICH CONSUMER GETS WHICH: the hedge decision and the δ_fut readout take futuresDeltaBtc; the
// position-size display and exchangeDeltaTotal take futuresNotionalBtc, because the latter
// reconciles against Deribit's own account delta_total, which is reported on the face convention.
export function markPerp(perpState, perp) {
  const qty = perpState?.qty ?? 0;
  const avgEntry = perpState?.avgEntry ?? 0;
  // Перп без цены - та же ветка нулей, что плоская позиция. Снимок деградирует так живьём: REST
  // перпа отказал, опционные ноги ответили, buildDeribitSnapshot отдал perp = null. Прежде это
  // роняло attribute() исключением из perp.contractSize, и весь тик (запись, персист, пуш) гиб
  // вместе с ним, хотя решение хеджа уже верно стояло в SKIP. Нули означают «маркировать нечем»:
  // реализованные счётчики позиции живут в perpState и в этой ветке не теряются.
  if (qty === 0 || avgEntry <= 0 || !(perp?.mark > 0) || !(perp?.contractSize > 0)) {
    return { futuresDeltaBtc: 0, futuresNotionalBtc: 0, upl_usd: 0, upl_btc: 0, notionalUsd: 0 };
  }
  const cs = perp.contractSize;
  const futuresDeltaBtc = (qty * cs) / avgEntry;
  const futuresNotionalBtc = (qty * cs) / perp.mark;
  const upl_btc = qty * cs * (1 / avgEntry - 1 / perp.mark);
  const upl_usd = upl_btc * perp.mark;
  const notionalUsd = Math.abs(qty) * cs;
  return { futuresDeltaBtc, futuresNotionalBtc, upl_usd, upl_btc, notionalUsd };
}

// ── Funding accrual (mutates perpState.fundingCum) ──────────────────────────────────────────────
// fundingRateOf(perp) → { rate, src }: ставка начисления (в единицах 8 часов) и её источник.
// ПЕРВОЙ берётся мгновенная ставка биржи `currentFunding` (src "current"), запасной `funding8h`
// (src "8h"); нет ни той, ни другой - { rate: null, src: null }, начислять нечем, и это решает
// вызывающий (engine.ingest не двигает часы фандинга на таком тике).
//
// ПОЧЕМУ МГНОВЕННАЯ, А НЕ ВОСЬМИЧАСОВАЯ, И ЭТО БЫЛ ДЕФЕКТ УЧЁТА. `funding_8h` тикера равен
// `interest_8h` биржи на каждой границе часа (замер 05.09.2026, 385 границ, 1.5e-6), то есть это
// СКОЛЬЗЯЩАЯ СУММА восьми прошедших часовых ставок, а биржа начисляет интеграл МГНОВЕННОЙ ставки
// по позиции. Начисление по среднему оплачивает всплеск ставки следующие восемь часов, уже на
// другом размере позиции: по дням книга расходилась с биржей на ±$3..6 при потоке около $10 в
// день (20.08: книга -5.91 против биржи -0.01), а за прогон 17.08-05.09 (mbp15, 107 341 тик,
// 87 сегментов позиции) переплатила $5.55 из $164: книга -164.31 против часового пути биржи
// -158.76, из них $4.86 это лаг среднего, остальное дискретизация тиков и кламп. Взвешивание
// позиции внутри часа почти не важно ($0.18): вся разница в лаге ставки.
//
// ПРОГНОЗ ОСТАЁТСЯ НА `funding8h`. estimateCost.funding_horizon, carry_horizon и стресс
// funding_stress оценивают карри на горизонт ВПЕРЁД, и среднее восьми часов предсказывает
// следующие часы лучше мгновенного значения; там нужен прогноз, а здесь начисление.
export function fundingRateOf(perp) {
  if (Number.isFinite(perp?.currentFunding)) return { rate: perp.currentFunding, src: "current" };
  if (Number.isFinite(perp?.funding8h)) return { rate: perp.funding8h, src: "8h" };
  return { rate: null, src: null };
}

// accrueFunding(perpState, perp, dtSec, { maxDtSec }) → { deltaUsd, gapSkippedSec, rate, src }.
// dtEff = min(dtSec, maxDtSec); deltaUsd = −qty·contractSize·rate·(dtEff/28800), rate по
// fundingRateOf (без ставки начисляется ноль, src null). A SHORT (qty<0) with positive rate
// RECEIVES → positive deltaUsd. fundingCum is accumulated in place; gapSkippedSec =
// max(0, dtSec − maxDtSec) reports time dropped by the anti-catch-up clamp.
export function accrueFunding(perpState, perp, dtSec, opts = {}) {
  const maxDtSec = opts.maxDtSec ?? Infinity;
  const dtEff = Math.min(dtSec, maxDtSec);
  const { rate, src } = fundingRateOf(perp);
  const deltaUsd = -perpState.qty * perp.contractSize * (rate ?? 0) * (dtEff / 28800);
  perpState.fundingCum = (perpState.fundingCum || 0) + deltaUsd;
  const gapSkippedSec = Math.max(0, dtSec - maxDtSec);
  return { deltaUsd, gapSkippedSec, rate, src };
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
// of the hedge and markPerp short-circuits to zero for a flat perp, net_total ≡ options_upl - the true
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
// An optional event.meta object rides along verbatim (the fa-ledger precedent: export.js reads
// e.meta) - settle rows use it to carry the strikes/unit the delivery reconcile needs.
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
    ...(event.meta ? { meta: event.meta } : {}),
  };
  engineState.ledger.push(stored);
  return stored;
}

// ── Delivery-price reconcile (S0 otm-scanner; P0 of the 2026-07-19 audit) ───────────────────────
// planSettleAdjustments(ledger, deliveryByDate) → [{ srcSeq, date, proxyPrice, deliveryPrice,
// adjustUsd }]. settleStructure settles on the index snapshot - an honest PROXY of Deribit's real
// delivery price (30-min index TWAP before 08:00 UTC). Once the official delivery price for the
// expiry DATE (UTC) is known, the correction is unit·(intrinsic(delivery) − intrinsic(proxy)) - the
// entry debit cancels in the difference. Pending = settle-options rows carrying meta {expiryMs,
// strikes, unit} with no settle-adjust row pointing back via meta.srcSeq. Dates absent from
// deliveryByDate stay pending (delivery publishes shortly after 08:00 UTC - the next pass gets them).
// Pure: the CALLER books the result (realizedOptionsUsd += adjustUsd + a settle-adjust row).
export function planSettleAdjustments(ledger, deliveryByDate) {
  const rows = Array.isArray(ledger) ? ledger : [];
  const adjusted = new Set(
    rows.filter((r) => r.type === "settle-adjust" && r.meta?.srcSeq != null).map((r) => r.meta.srcSeq),
  );
  const out = [];
  for (const r of rows) {
    if (r.type !== "settle-options" || !r.meta || adjusted.has(r.seq)) continue;
    const { expiryMs, strikes, unit, legs } = r.meta;
    if (!Number.isFinite(expiryMs) || !Number.isFinite(unit) || !(legs?.length || strikes)) continue;
    const date = new Date(expiryMs).toISOString().slice(0, 10);
    const deliveryPrice = deliveryByDate ? deliveryByDate[date] : undefined;
    if (!Number.isFinite(deliveryPrice)) continue;
    // Геометрия берётся из НОГ; строки, записанные до появления meta.legs, считаются по страйкам
    // тента, как и считались (у них другой структуры и не было).
    const perUnit = legs?.length
      ? (S) => intrinsicOfLegs({ legs }, S)
      : (S) => intrinsicAt(strikes, S);
    const adjustUsd = unit * (perUnit(deliveryPrice) - perUnit(r.priceRef));
    out.push({ srcSeq: r.seq, date, proxyPrice: r.priceRef, deliveryPrice, adjustUsd });
  }
  return out;
}

// ── Reconciliation ──────────────────────────────────────────────────────────────────────────────
// ledgerReconciles(engineState, snapshot) → { ok, identityDelta, feesDelta, realizedDelta }.
// Checks the attribution identity closes AND that the ledger's independent sums equal the running
// accumulators. ok = every delta < 1e-6·max(1, |net_total|).
//   • Funding is deliberately NOT reconciled against rows: accrual is accumulator-only
//     (perpState.fundingCum) and the journal carries no funding rows by design (guide §8) - a
//     sum-vs-accumulator check here would fail on every session that ever accrued funding.
//   • realizedUsd rows come from TWO sources - hedge/close-perp (→ perpState.realizedUsd) and
//     close-options/settle-options (→ engineState.realizedOptionsUsd) - so the row sum reconciles
//     against the SUM of both accumulators, not the perp one alone.
export function ledgerReconciles(engineState, snapshot) {
  const a = attribute(engineState, snapshot);
  const identityDelta = Math.abs(
    a.net_total - (a.options_upl + a.futures_upl + a.funding_total - a.fees_total),
  );
  const ledger = engineState.ledger ?? [];
  const sum = (key) => ledger.reduce((acc, e) => acc + (e[key] || 0), 0);
  const perpState = engineState.perpState;
  const feesDelta = Math.abs(sum("feeUsd") - (perpState.feesCum || 0));
  const realizedDelta = Math.abs(
    sum("realizedUsd") - ((perpState.realizedUsd || 0) + (engineState.realizedOptionsUsd || 0)),
  );
  const tol = 1e-6 * Math.max(1, Math.abs(a.net_total));
  const ok = identityDelta < tol && feesDelta < tol && realizedDelta < tol;
  return { ok, identityDelta, feesDelta, realizedDelta };
}
