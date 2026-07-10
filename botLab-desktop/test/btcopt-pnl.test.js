// btcopt-pnl.test.js — golden + sign-lock tests for the «BTC-опционы» P&L attribution core.
// Options are LINEAR USDC (USD-native marks, no ×index); the hedge is an INVERSE BTC perpetual
// ($10/contract, BTC-denominated PnL). The point of these tests is to pin the inverse mark-to-market
// and funding signs EXACTLY, and to prove the attribution identity + ledger reconciliation close.
import test from "node:test";
import assert from "node:assert/strict";
import {
  markStructure,
  markPerp,
  accrueFunding,
  attribute,
  noHedgeAttribute,
  appendLedger,
  ledgerReconciles,
} from "../src/engine/btcopt/pnl.js";

const near = (a, b, tol, l) => assert.ok(Math.abs(a - b) < tol, `${l}: got ${a} want ${b}`);

// ── markStructure (LINEAR options — USD marks, no ×index) ───────────────────────────────────────
test("markStructure: one long ATM call, mark 200→2090 → upl_usd +1890", () => {
  const structure = { legs: [{ instrument: "C", qtySigned: +1, entryMark: 200, contractSize: 1, markInUsd: true }] };
  const snapshot = { legs: { C: { mark: 2090 } } };
  const r = markStructure(structure, snapshot);
  assert.equal(r.upl_usd, 1890); // 1·(2090−200)·1
  assert.equal(r.byLeg.length, 1);
  assert.equal(r.byLeg[0].instrument, "C");
  assert.equal(r.byLeg[0].upl_usd, 1890);
  assert.equal(r.byLeg[0].value_usd, 2090); // 1·2090·1
});

test("markStructure: a short leg gains when the mark drops (sign lock)", () => {
  const structure = { legs: [{ instrument: "P", qtySigned: -2, entryMark: 300, contractSize: 1 }] };
  const snapshot = { legs: { P: { mark: 250 } } };
  const r = markStructure(structure, snapshot);
  assert.equal(r.upl_usd, 100); // −2·(250−300)·1 = +100
  assert.equal(r.byLeg[0].value_usd, -500); // −2·250·1
});

test("markStructure: leg missing from snapshot falls back to entryMark → 0 upl", () => {
  const structure = { legs: [{ instrument: "X", qtySigned: 1, entryMark: 200, contractSize: 1 }] };
  const r = markStructure(structure, { legs: {} });
  assert.equal(r.upl_usd, 0);
  assert.equal(r.byLeg[0].value_usd, 200); // 1·200·1 (marked at entry)
});

test("markStructure: multi-leg Σ (long call +1890, short put +100) = +1990", () => {
  const structure = {
    legs: [
      { instrument: "C", qtySigned: +1, entryMark: 200, contractSize: 1 },
      { instrument: "P", qtySigned: -2, entryMark: 300, contractSize: 1 },
    ],
  };
  const snapshot = { legs: { C: { mark: 2090 }, P: { mark: 250 } } };
  assert.equal(markStructure(structure, snapshot).upl_usd, 1990);
});

// ── markPerp (INVERSE $10 perpetual — BTC-denominated PnL) ───────────────────────────────────────
test("markPerp inverse: short −13 @63000, mark 60000 → gains as price drops", () => {
  const r = markPerp({ qty: -13, avgEntry: 63000 }, { mark: 60000, contractSize: 10 });
  near(r.futuresDeltaBtc, -0.0021667, 1e-6, "futuresDeltaBtc"); // −130/60000
  near(r.upl_usd, 6.190476, 1e-5, "upl_usd"); // −130·(60000−63000)/63000, short PROFITS
  near(r.upl_btc, 0.00010317, 1e-6, "upl_btc"); // −130·(1/63000 − 1/60000)
  assert.equal(r.notionalUsd, 130); // |−13|·10
  assert.ok(r.upl_usd > 0, "short must profit as price falls");
});

test("markPerp inverse: long +13 is the exact mirror (sign lock)", () => {
  const r = markPerp({ qty: +13, avgEntry: 63000 }, { mark: 60000, contractSize: 10 });
  near(r.upl_usd, -6.190476, 1e-5, "upl_usd"); // long LOSES as price falls
  near(r.futuresDeltaBtc, 0.0021667, 1e-6, "futuresDeltaBtc");
  assert.ok(r.upl_usd < 0, "long must lose as price falls");
});

test("markPerp: flat / unpriced (qty 0, avgEntry 0) → all zeros", () => {
  const r = markPerp({ qty: 0, avgEntry: 0 }, { mark: 60000, contractSize: 10 });
  assert.deepEqual(r, { futuresDeltaBtc: 0, upl_usd: 0, upl_btc: 0, notionalUsd: 0 });
});

test("markPerp: upl_usd equals upl_btc·mark (inverse identity)", () => {
  const r = markPerp({ qty: -7, avgEntry: 61000 }, { mark: 59000, contractSize: 10 });
  near(r.upl_usd, r.upl_btc * 59000, 1e-9, "upl_usd == upl_btc·mark");
});

// ── accrueFunding (short RECEIVES positive funding; mutates fundingCum) ──────────────────────────
test("accrueFunding: short −13, funding8h +0.0001, one 8h window → +0.013 received", () => {
  const perpState = { qty: -13, fundingCum: 0 };
  const r = accrueFunding(perpState, { funding8h: 0.0001, contractSize: 10 }, 28800, { maxDtSec: 1e9 });
  near(r.deltaUsd, 0.013, 1e-9, "deltaUsd"); // −(−13)·10·0.0001·1
  near(perpState.fundingCum, 0.013, 1e-9, "fundingCum accrued");
  assert.equal(r.gapSkippedSec, 0);
  assert.ok(r.deltaUsd > 0, "short receives positive funding");
});

test("accrueFunding: dt clamps to maxDtSec, reporting the skipped gap", () => {
  const perpState = { qty: -13, fundingCum: 0 };
  const r = accrueFunding(perpState, { funding8h: 0.0001, contractSize: 10 }, 100000, { maxDtSec: 28800 });
  near(r.deltaUsd, 0.013, 1e-9, "deltaUsd clamped to one window"); // dtEff = 28800
  assert.equal(r.gapSkippedSec, 71200); // 100000 − 28800
});

test("accrueFunding: long PAYS positive funding (sign lock)", () => {
  const perpState = { qty: +13, fundingCum: 0 };
  const r = accrueFunding(perpState, { funding8h: 0.0001, contractSize: 10 }, 28800, { maxDtSec: 1e9 });
  near(r.deltaUsd, -0.013, 1e-9, "deltaUsd"); // long pays → negative
  assert.ok(r.deltaUsd < 0, "long pays positive funding");
});

test("accrueFunding: successive calls accumulate into fundingCum", () => {
  const perpState = { qty: -13, fundingCum: 0 };
  accrueFunding(perpState, { funding8h: 0.0001, contractSize: 10 }, 28800, { maxDtSec: 1e9 });
  accrueFunding(perpState, { funding8h: 0.0001, contractSize: 10 }, 28800, { maxDtSec: 1e9 });
  near(perpState.fundingCum, 0.026, 1e-9, "fundingCum accumulates");
});

// ── attribute + ledgerReconciles (the golden end-to-end) ────────────────────────────────────────
function goldenState() {
  return {
    structure: { legs: [{ instrument: "C", qtySigned: 1, entryMark: 200, contractSize: 1 }] },
    perpState: { qty: 0, avgEntry: 0, realizedUsd: -310, fundingCum: -200, feesCum: 140 },
    ledger: [{ feeUsd: 140, realizedUsd: -310, fundingUsd: -200 }],
  };
}
const goldenSnapshot = { legs: { C: { mark: 2090 } }, perp: { mark: 60000, contractSize: 10 } };

test("attribute: golden buckets and net identity (net = 1240)", () => {
  const a = attribute(goldenState(), goldenSnapshot);
  assert.equal(a.options_upl, 1890);
  assert.equal(a.futures_upl, -310); // realized −310 + 0 mark (perp flat)
  assert.equal(a.funding_total, -200);
  assert.equal(a.fees_total, 140);
  assert.equal(a.net_total, 1240); // 1890 − 310 − 200 − 140
  assert.equal(a.vs_no_hedge, 1240 - 1890); // net − options = −650 (hedge net contribution)
});

test("attribute: null structure → options_upl 0", () => {
  const a = attribute({ structure: null, perpState: { qty: 0, avgEntry: 0 } }, goldenSnapshot);
  assert.equal(a.options_upl, 0);
  assert.equal(a.net_total, 0);
});

test("attribute: folds live inverse mark into futures_upl", () => {
  const st = {
    structure: null,
    perpState: { qty: -13, avgEntry: 63000, realizedUsd: 100, fundingCum: 0, feesCum: 0 },
  };
  const a = attribute(st, goldenSnapshot); // perp.mark 60000
  near(a.futures_upl, 100 + 6.190476, 1e-5, "futures_upl = realized + mark"); // 100 + inverse upl
});

// ── noHedgeAttribute (Phase 2a shadow book — perp zeroed) ────────────────────────────────────────
test("noHedgeAttribute: shadow net ≡ options_upl, and (hedged − shadow) ≡ vs_no_hedge", () => {
  const st = goldenState();
  const hedged = attribute(st, goldenSnapshot);
  const shadow = noHedgeAttribute(st, goldenSnapshot);
  assert.equal(shadow.net_total, 1890); // options only — no perp realized/funding/fees
  assert.equal(shadow.net_total, hedged.options_upl);
  near(hedged.net_total - shadow.net_total, hedged.vs_no_hedge, 1e-9, "contribution ≡ vs_no_hedge");
});

test("noHedgeAttribute: 'over-hedged choppy day' — hedging turns +0.90 options into −0.05 net", () => {
  // spec pp.9: options MTM +0.90, futures +0.35, fees+funding −1.30 → net −0.05; the hedge COST 0.95.
  const st = {
    structure: { legs: [{ instrument: "C", qtySigned: 1, entryMark: 200, contractSize: 1 }] },
    realizedOptionsUsd: 0,
    perpState: { qty: 0, avgEntry: 0, realizedUsd: 0.35, fundingCum: -0.1, feesCum: 1.2 },
  };
  const snap = { legs: { C: { mark: 200.9 } }, perp: { mark: 60000, contractSize: 10 } };
  const hedged = attribute(st, snap);
  const shadow = noHedgeAttribute(st, snap);
  near(shadow.net_total, 0.9, 1e-9, "no-hedge net = options only +0.90");
  near(hedged.net_total, -0.05, 1e-9, "hedged net −0.05");
  near(hedged.net_total - shadow.net_total, -0.95, 1e-9, "hedge cost 0.95 net (helped=false)");
});

test("ledgerReconciles: golden reconciles (ok true, all deltas 0)", () => {
  const r = ledgerReconciles(goldenState(), goldenSnapshot);
  assert.equal(r.ok, true);
  near(r.identityDelta, 0, 1e-9, "identityDelta");
  near(r.feesDelta, 0, 1e-9, "feesDelta");
  near(r.realizedDelta, 0, 1e-9, "realizedDelta");
  near(r.fundingDelta, 0, 1e-9, "fundingDelta");
});

test("ledgerReconciles: a ledger that disagrees with the accumulators fails", () => {
  const st = goldenState();
  st.ledger[0].feeUsd = 999; // ledger fees no longer match perpState.feesCum (140)
  const r = ledgerReconciles(st, goldenSnapshot);
  assert.equal(r.ok, false);
  near(r.feesDelta, 859, 1e-9, "feesDelta = |999 − 140|");
});

// ── appendLedger (sequencing + numeric-safe defaults) ───────────────────────────────────────────
test("appendLedger: assigns 1-based seq and defaults every numeric field to 0", () => {
  const st = { ledger: [] };
  const e1 = appendLedger(st, { t: 111, type: "hedge", side: "buy", contracts: 3, feeUsd: 0.5 });
  assert.equal(e1.seq, 1);
  assert.equal(e1.t, 111);
  assert.equal(e1.type, "hedge");
  assert.equal(e1.contracts, 3);
  assert.equal(e1.feeUsd, 0.5);
  // untouched numeric fields default to 0 (so downstream sums never see undefined)
  assert.equal(e1.priceRef, 0);
  assert.equal(e1.deltaBtc, 0);
  assert.equal(e1.fundingUsd, 0);
  assert.equal(e1.realizedUsd, 0);

  const e2 = appendLedger(st, {});
  assert.equal(e2.seq, 2);
  assert.equal(st.ledger.length, 2);
  assert.equal(e2.contracts, 0);
});

test("appendLedger: rows feed ledgerReconciles cleanly (built, not hand-crafted)", () => {
  const st = {
    structure: null,
    perpState: { qty: 0, avgEntry: 0, realizedUsd: -310, fundingCum: -200, feesCum: 140 },
    ledger: [],
  };
  appendLedger(st, { type: "fee", feeUsd: 140 });
  appendLedger(st, { type: "realized", realizedUsd: -310 });
  appendLedger(st, { type: "funding", fundingUsd: -200 });
  const r = ledgerReconciles(st, goldenSnapshot);
  assert.equal(r.ok, true);
});
