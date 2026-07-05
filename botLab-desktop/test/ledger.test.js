// ledger.test.js — the transaction-ledger derivation and its reconciliation identity.
// The ledger is a pure function of the position; these tests lock:
//   * event composition per accrual source (live / history / skipped / cap-trimmed),
//   * the funding/borrow split summing EXACTLY to dPnlGmx,
//   * the legacy fallback (pre-feature accruals without the split) staying honest,
//   * sum(income) - sum(expense) === last runningBalance === positionSummary().netPnl,
//   * ledgerView paging/filtering/counts serving the renderer and the oracle alike.

import test from "node:test";
import assert from "node:assert/strict";
import { openPosition, accrue, recordUnpricedGap, positionSummary } from "../src/engine/paper.js";
import { buildLedger, ledgerTotals, ledgerReconciles, ledgerView, LEDGER_TYPES } from "../src/engine/ledger.js";
import { roundTripCost, roundTripCostBreakdown } from "../src/engine/costs.js";

const HOUR = 3600 * 1000;
const BASE = 1699999200000; // hour-aligned epoch ms
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label}: got ${a}, want ${b} (+/-${tol})`);
const SNAP = { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 2e-9, hl_rate: 1e-5 };

function openTwoLeg(rt = 4.1) {
  return openPosition({
    strategy: "two",
    instrumentKey: "ETH",
    config: "A",
    capital: 100000,
    leverage: 1,
    nowMs: BASE,
    roundTripCost: rt,
    costBreakdown: { gmxOpenUsd: 1, gmxCloseUsd: 1, gmxImpactUsd: 1, gmxGasUsd: 1, hlTakerUsd: 0.1 },
    openMarkPx: 3210.5,
  });
}

test("buildLedger: open_costs is always seq 0 at t0, even with zero accruals", () => {
  const p = openTwoLeg();
  const ev = buildLedger(p);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].seq, 0);
  assert.equal(ev[0].type, "open_costs");
  assert.equal(ev[0].t, BASE);
  near(ev[0].amount, -4.1, 1e-12, "open costs are an expense");
  near(ev[0].expense, 4.1, 1e-12, "expense column");
  assert.equal(ev[0].income, 0);
  assert.equal(ev[0].priceAtOp, 3210.5, "t0 mark frozen on the position");
  assert.ok(ev[0].breakdown && ev[0].breakdown.gmxGasUsd === 1, "breakdown snapshot carried");
  const rec = ledgerReconciles(p, ev);
  assert.ok(rec.ok, `empty-accrual ledger reconciles: ${JSON.stringify(rec)}`);
});

test("buildLedger: 1h two-leg accrual → funding + borrow + HL rows, split sums to dPnlGmx", () => {
  const p = openTwoLeg();
  accrue(p, SNAP, BASE + HOUR, { markPx: 3300 });
  const ev = buildLedger(p);
  const types = ev.map((e) => e.type);
  assert.deepEqual(types, ["open_costs", "gmx_funding", "gmx_borrow", "hl_funding"]);
  const [, f, b, h] = ev;
  near(f.amount, 1e-8 * 3600 * 100000, 1e-12, "funding priced from its own factor"); // +3.6
  near(f.amount + b.amount, p.accruals[0].dPnlGmx, 0, "split sums EXACTLY to dPnlGmx");
  assert.ok(b.amount < 0, "borrow is an expense");
  near(h.amount, -1.0, 1e-9, "HL settlement (config A long leg pays)");
  assert.equal(f.direction, "short");
  assert.equal(h.direction, "long");
  assert.equal(f.priceAtOp, 3300, "live mark recorded on the accrual");
  assert.equal(h.fundingIntervalSec, 3600);
  assert.ok(ev.every((e, i) => e.seq === i), "seq is dense and monotonic");
  const rec = ledgerReconciles(p, ev);
  assert.ok(rec.ok, `reconciles: ${JSON.stringify(rec)}`);
  near(rec.netFromEvents, positionSummary(p).netPnl, 1e-9, "sum(income)-sum(expense) = netPnl");
  near(ev[ev.length - 1].runningBalance, positionSummary(p).netPnl, 1e-9, "last running balance = netPnl");
});

test("buildLedger: legacy accrual entries (no split) render as ONE aggregated funding row", () => {
  const p = openTwoLeg();
  accrue(p, SNAP, BASE + HOUR);
  // simulate a position persisted by a pre-ledger build
  delete p.accruals[0].fundingUsd;
  delete p.accruals[0].borrowUsd;
  delete p.accruals[0].markPx;
  const ev = buildLedger(p);
  assert.deepEqual(ev.map((e) => e.type), ["open_costs", "gmx_funding", "hl_funding"], "no fabricated borrow row");
  const f = ev[1];
  assert.equal(f.meta.aggregated, true, "honesty marker present");
  near(f.amount, p.accruals[0].dPnlGmx, 0, "aggregated row carries the combined net");
  assert.equal(f.priceAtOp, null, "no fabricated price");
  assert.ok(ledgerReconciles(p, ev).ok, "legacy ledger still reconciles");
});

test("buildLedger: skipped interval → $0 gap row, balance unchanged, still reconciles", () => {
  const p = openTwoLeg();
  accrue(p, SNAP, BASE + HOUR);
  recordUnpricedGap(p, BASE + 2 * HOUR, "required live data unavailable");
  const ev = buildLedger(p);
  const gap = ev[ev.length - 1];
  assert.equal(gap.type, "gap_unpriced");
  assert.equal(gap.amount, 0);
  assert.equal(gap.category, "neutral");
  near(gap.meta.gapSkippedSec, 3600, 1e-9, "gap length recorded");
  assert.equal(gap.meta.reason, "required live data unavailable");
  near(gap.runningBalance, ev[ev.length - 2].runningBalance, 0, "zero-amount row repeats the balance");
  assert.ok(ledgerReconciles(p, ev).ok);
});

test("buildLedger: cap-trimmed live step emits a gap marker BEFORE the priced rows", () => {
  const p = openTwoLeg();
  accrue(p, SNAP, BASE + HOUR, { maxDtSec: 900 }); // 1h elapsed, only 15m priced
  const ev = buildLedger(p);
  assert.equal(ev[1].type, "gap_unpriced");
  near(ev[1].meta.gapSkippedSec, 2700, 1e-9, "uncovered remainder surfaced");
  assert.equal(ev[2].type, "gmx_funding");
  near(ev[2].amount, 1e-8 * 900 * 100000, 1e-12, "funding priced over the capped window only");
  assert.ok(ledgerReconciles(p, ev).ok);
});

test("buildLedger: one-leg positions have no HL rows", () => {
  const p = openPosition({ strategy: "one", instrumentKey: "ETH-Arb", capital: 100000, leverage: 1, nowMs: BASE, roundTripCost: 2.2 });
  accrue(p, { f_short: 1e-8, b_short: 2e-9, f_long: 0, b_long: 0, hl_rate: 0 }, BASE + HOUR);
  const ev = buildLedger(p);
  assert.deepEqual(ev.map((e) => e.type), ["open_costs", "gmx_funding", "gmx_borrow"]);
  assert.equal(ev[0].strategyLeg, "gmx");
  assert.ok(ledgerReconciles(p, ev).ok);
});

test("roundTripCostBreakdown parts sum to the exact roundTripCost total (both strategies)", () => {
  for (const oneLeg of [false, true]) {
    const total = roundTripCost({}, 100000, oneLeg);
    const b = roundTripCostBreakdown({}, 100000, oneLeg);
    const sum = b.gmxOpenUsd + b.gmxCloseUsd + b.gmxImpactUsd + b.gmxGasUsd + b.hlTakerUsd;
    near(sum, total, 1e-9, `breakdown identity (oneLeg=${oneLeg})`);
    if (oneLeg) assert.equal(b.hlTakerUsd, 0, "no HL leg cost for GMX-only carry");
  }
});

test("ledgerView: paging, ordering, counts and filter subtotals", () => {
  const p = openTwoLeg();
  for (let i = 1; i <= 30; i++) accrue(p, SNAP, BASE + i * 10 * 60 * 1000); // 30 ten-minute ticks over 5h
  const all = buildLedger(p);

  const v = ledgerView(p, { offset: 0, limit: 10, order: "desc" });
  assert.equal(v.events.length, 10);
  assert.equal(v.totalCount, all.length);
  assert.equal(v.allCount, all.length);
  assert.equal(v.events[0].seq, all[all.length - 1].seq, "desc: newest first");
  assert.ok(v.events.every((e, i) => i === 0 || v.events[i - 1].seq > e.seq), "desc strictly ordered");

  const v2 = ledgerView(p, { offset: 10, limit: 10, order: "desc" });
  assert.equal(v2.events[0].seq, v.events[9].seq - 1, "offset continues where page 1 ended");

  const asc = ledgerView(p, { offset: 0, limit: 5, order: "asc" });
  assert.equal(asc.events[0].seq, 0, "asc starts at open_costs");

  // counts cover every type and sum to the full ledger
  const totalByCounts = LEDGER_TYPES.reduce((s, t) => s + v.counts[t], 0);
  assert.equal(totalByCounts, all.length);
  assert.equal(v.counts.open_costs, 1);
  assert.equal(v.counts.hl_funding, 5, "5 crossed hour boundaries in 5h");

  // filtered view: totalsAll stays FULL, filteredTotals is the labeled subtotal
  const f = ledgerView(p, { types: ["hl_funding"], limit: 100 });
  assert.equal(f.totalCount, 5);
  assert.ok(f.events.every((e) => e.type === "hl_funding"));
  near(f.totalsAll.net, ledgerTotals(all).net, 1e-12, "headline totals ignore the filter");
  near(f.filteredTotals.net, -5.0, 1e-9, "5 HL settlements × -$1");

  // dayNets over the filtered set sums to the filtered net
  const daySum = Object.values(f.dayNets).reduce((s, x) => s + x, 0);
  near(daySum, f.filteredTotals.net, 1e-9, "day separators sum to the subtotal");

  assert.ok(v.recon.ok, "view carries the reconciliation verdict");
  near(v.recon.positionNetPnl, positionSummary(p).netPnl, 0, "verdict pinned to positionSummary");
});
