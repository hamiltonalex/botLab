// ledger.test.js - the transaction-ledger derivation and its reconciliation identity.
// The ledger is a pure function of the position; these tests lock:
//   * event composition per accrual source (live / history / skipped / cap-trimmed),
//   * the funding/borrow split summing EXACTLY to dPnlGmx,
//   * the legacy fallback (pre-feature accruals without the split) staying honest,
//   * sum(income) - sum(expense) === last runningBalance === positionSummary().netPnl,
//   * ledgerView paging/filtering/counts serving the renderer and the oracle alike.

import test from "node:test";
import assert from "node:assert/strict";
import { openPosition, accrue, recordUnpricedGap, positionSummary, closePosition } from "../src/engine/paper.js";
import { buildLedger, ledgerTotals, ledgerReconciles, ledgerView, LEDGER_TYPES } from "../src/engine/ledger.js";
import { roundTripCost, roundTripCostBreakdown, splitRoundTripCost } from "../src/engine/costs.js";

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
  // входная половина круга: открытие 1 + половина impact 0.5 + половина газа 0.5 + taker одной стороны 0.05
  near(ev[0].amount, -2.05, 1e-12, "entry costs are an expense");
  near(ev[0].expense, 2.05, 1e-12, "expense column");
  assert.equal(ev[0].income, 0);
  assert.equal(ev[0].priceAtOp, 3210.5, "t0 mark frozen on the position");
  assert.ok(ev[0].breakdown && ev[0].breakdown.gmxGasUsd === 0.5 && ev[0].breakdown.gmxOpenUsd === 1, "entry breakdown carried (halves)");
  assert.equal(ev[0].breakdown.gmxCloseUsd, undefined, "no close fee on the entry row");
  near(ev[0].breakdown.roundTripUsd, 4.1, 1e-12, "the full round trip stands for reference");
  const rec = ledgerReconciles(p, ev);
  assert.ok(rec.ok, `empty-accrual ledger reconciles: ${JSON.stringify(rec)}`);
  near(rec.positionBookedNetPnl, -2.05, 1e-12, "booked = gross - entry while open");
  near(rec.pendingExitUsd, 2.05, 1e-12, "the exit half is pending");
  near(rec.positionNetPnl, -4.1, 1e-12, "netPnl still carries the full round trip");
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
  const s = positionSummary(p);
  near(rec.netFromEvents, s.bookedNetPnl, 1e-9, "sum(income)-sum(expense) = booked net (exit not charged yet)");
  near(ev[ev.length - 1].runningBalance, s.bookedNetPnl, 1e-9, "last running balance = booked net");
  near(s.bookedNetPnl - s.exitPendingUsd, s.netPnl, 1e-9, "booked - pending exit = netPnl");
});

test("splitRoundTripCost: вход + выход = круг побитово, половины по соглашению, без детализации пополам", () => {
  for (const oneLeg of [false, true]) {
    const total = roundTripCost({}, 2500, oneLeg);
    const b = roundTripCostBreakdown({}, 2500, oneLeg);
    const sp = splitRoundTripCost({ roundTripCost: total, costBreakdown: b });
    assert.equal(sp.byModel, true);
    assert.equal(sp.entryUsd + sp.exitUsd, total, `identity entry + exit = round trip (oneLeg=${oneLeg})`);
    near(sp.entryUsd, b.gmxOpenUsd + b.gmxImpactUsd / 2 + b.gmxGasUsd / 2 + b.hlTakerUsd / 2, 1e-12, "entry half by convention");
    assert.equal(sp.entry.gmxCloseUsd, undefined);
    assert.equal(sp.exit.gmxOpenUsd, undefined);
    if (!oneLeg) near(sp.entryUsd, 4.375, 1e-12, "$2500 two-leg: $4.375 at entry");
  }
  const plain = splitRoundTripCost({ roundTripCost: 8.75 });
  assert.deepEqual([plain.entryUsd, plain.exitUsd, plain.byModel, plain.entry], [4.375, 4.375, false, null]);
  assert.equal(splitRoundTripCost({ roundTripCost: NaN }), null);
  assert.equal(splitRoundTripCost({ roundTripCost: 4, costBreakdown: { gmxOpenUsd: 1 } }).byModel, false, "неполная детализация читается как её отсутствие");
});

test("buildLedger: закрытая позиция несёт строку close_costs на момент закрытия, журнал сходится с нетто целиком", () => {
  const p = openTwoLeg();
  accrue(p, SNAP, BASE + HOUR, { markPx: 3300 });
  closePosition(p, BASE + HOUR + 1000);
  const ev = buildLedger(p);
  assert.deepEqual(ev.map((e) => e.type), ["open_costs", "gmx_funding", "gmx_borrow", "hl_funding", "close_costs"]);
  const c = ev[ev.length - 1];
  assert.equal(c.t, BASE + HOUR + 1000, "close costs land on closedAt");
  near(c.amount, -2.05, 1e-12, "exit half charged at close");
  assert.equal(c.source, "close");
  assert.ok(c.breakdown && c.breakdown.gmxCloseUsd === 1 && c.breakdown.gmxOpenUsd === undefined, "exit breakdown: close fee, no open fee");
  assert.ok(ev.every((e, i) => e.seq === i), "seq dense through the close row");
  const s = positionSummary(p);
  assert.equal(s.exitCharged, true);
  assert.equal(s.exitPendingUsd, 0);
  near(s.bookedNetPnl, s.netPnl, 1e-12, "after close booked = net");
  const rec = ledgerReconciles(p, ev);
  assert.ok(rec.ok, `closed ledger reconciles: ${JSON.stringify(rec)}`);
  near(rec.netFromEvents, s.netPnl, 1e-9, "sum over the closed ledger = netPnl");
  const v = ledgerView(p);
  assert.equal(v.pending.open, false);
  assert.equal(v.counts.close_costs, 1);
});

test("ledgerView.pending: у открытой позиции несёт не списанный выход и оба нетто, отрисовщику вычитать нечего", () => {
  const p = openTwoLeg();
  accrue(p, SNAP, BASE + HOUR, { markPx: 3300 });
  const v = ledgerView(p);
  assert.equal(v.pending.open, true);
  near(v.pending.exitUsd, 2.05, 1e-12);
  near(v.pending.bookedNetPnl - v.pending.exitUsd, v.pending.netPnl, 1e-9);
  near(v.recon.positionBookedNetPnl, v.totalsAll.net, 1e-9, "totals of the open ledger equal booked");
  assert.equal(v.counts.close_costs, 0);
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

test("buildLedger: строка расчёта HL называет источник ставки границы; старые записи без метки", () => {
  const p = openTwoLeg();
  accrue(p, SNAP, BASE + HOUR, { markPx: 3300, hlSettle: { rate: 1.25e-5, src: "venue" } });
  const h = buildLedger(p).find((e) => e.type === "hl_funding");
  assert.equal(h.meta.hlRateSrc, "venue");
  assert.equal(h.meta.hlRate, 1.25e-5);
  assert.match(h.description, /по расчётной ставке биржи/);
  const q = openTwoLeg();
  accrue(q, SNAP, BASE + HOUR, { markPx: 3300 });
  const hq = buildLedger(q).find((e) => e.type === "hl_funding");
  assert.equal(hq.meta.hlRateSrc, "live");
  assert.match(hq.description, /прогноз/);
  // Запись до появления метки: суффикса нет, метка null, тождество журнала держится.
  delete q.accruals[0].hlRateSrc;
  delete q.accruals[0].hlRate;
  const old = buildLedger(q).find((e) => e.type === "hl_funding");
  assert.equal(old.meta.hlRateSrc, null);
  assert.equal(old.meta.hlRate, null);
  assert.ok(!/прогноз|биржи|границы/.test(old.description));
  assert.ok(ledgerReconciles(q, buildLedger(q)).ok);
});
