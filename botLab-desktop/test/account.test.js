// account.test.js — account-level roll-up (accountSummary) + portfolio drawdown (combinedMaxDrawdown).
// Covers the audit fixes: annualize over the ACTUAL accrual horizon (no wall-clock decay after
// close), notionalAll = Σ leveraged notional, and portfolio maxDrawdown from the COMBINED equity
// curve (not the sum of per-position troughs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { openPosition, accrue, closePosition, positionSummary, accountSummary, combinedMaxDrawdown } from "../src/engine/paper.js";

const SEC_PER_YEAR = 3600 * 8760;
// A steady positive-carry snapshot: +15% APR short funding, 2% borrow, HL baseline.
const SNAP = {
  f_long: -0.15 / SEC_PER_YEAR,
  f_short: 0.15 / SEC_PER_YEAR,
  b_long: 0.02 / SEC_PER_YEAR,
  b_short: 0.02 / SEC_PER_YEAR,
  hl_rate: 0.0000125,
};

test("combinedMaxDrawdown: non-coincident troughs are NOT summed (uses the combined curve)", () => {
  // A troughs -500 at t=2 (recovers by t=3); B troughs -500 at t=4. Never down together.
  const A = { equityCurve: [{ t: 1, cum: 0 }, { t: 2, cum: -500 }, { t: 3, cum: 0 }] };
  const B = { equityCurve: [{ t: 1, cum: 0 }, { t: 4, cum: -500 }, { t: 5, cum: 0 }] };
  const dd = combinedMaxDrawdown([A, B]);
  assert.equal(dd, -500, "combined drawdown is the worst single-instant excursion, not -1000");
});

test("combinedMaxDrawdown: coincident troughs DO add (equals the sum in the degenerate case)", () => {
  const A = { equityCurve: [{ t: 1, cum: 0 }, { t: 2, cum: -500 }, { t: 3, cum: 0 }] };
  const B = { equityCurve: [{ t: 1, cum: 0 }, { t: 2, cum: -500 }, { t: 3, cum: 0 }] };
  assert.equal(combinedMaxDrawdown([A, B]), -1000);
});

test("combinedMaxDrawdown: single position equals its own drawdown; empty book is 0", () => {
  const A = { equityCurve: [{ t: 1, cum: 0 }, { t: 2, cum: -300 }, { t: 3, cum: 120 }] };
  assert.equal(combinedMaxDrawdown([A]), -300);
  assert.equal(combinedMaxDrawdown([]), 0);
  assert.equal(combinedMaxDrawdown([{ equityCurve: [] }]), 0);
});

test("accountSummary: realized APR is frozen at the accrual horizon and does NOT decay with wall-clock", () => {
  const t0 = 1_700_000_000_000;
  const cap = 100000, lev = 1;
  const p = openPosition({ strategy: "two", instrumentKey: "APT", config: "A", capital: cap, leverage: lev, nowMs: t0, roundTripCost: 300, meta: { token: "APT" } });
  accrue(p, SNAP, t0 + 48 * 3600 * 1000, { maxDtSec: 3600 * 72 }); // 48h of accrual
  closePosition(p, t0 + 48 * 3600 * 1000);

  const a1 = accountSummary([p]);
  // Recompute much later in wall-clock time: accountSummary takes no `now`, so the horizon is fixed
  // at the last accrual — the APR must be identical, not decayed.
  const a2 = accountSummary([p]);
  assert.ok(Math.abs(a1.hoursSinceFirst - 48) < 1e-6, "horizon is the 48h accrual window");
  assert.equal(a1.apr, a2.apr, "APR does not change as wall-clock advances");
  assert.equal(a1.aprGross, a2.aprGross);
  // Account APR matches the single position's own frozen APR.
  const s = positionSummary(p);
  assert.ok(Math.abs(a1.apr - s.apr) < 1e-9, "account APR == position APR for a single position");
  assert.equal(a1.aprReliable, true, "48h >= 24h threshold");
});

test("accountSummary: notionalAll is Σ leveraged notional (not capital) and P&L aggregates", () => {
  const t0 = 1_700_000_000_000;
  const p1 = openPosition({ strategy: "two", instrumentKey: "APT", config: "A", capital: 100000, leverage: 10, nowMs: t0, roundTripCost: 3100, meta: { token: "APT" } });
  const p2 = openPosition({ strategy: "one", instrumentKey: "ETH-Arb", capital: 50000, leverage: 1, nowMs: t0, roundTripCost: 110, meta: { token: "ETH" } });
  const a = accountSummary([p1, p2]);
  assert.equal(a.capitalAll, 150000);
  assert.equal(a.notionalAll, 100000 * 10 + 50000 * 1, "1,050,000 leveraged notional");
  assert.equal(a.count, 2);
  assert.equal(a.open, 2);
});

test("accountSummary: empty account returns null", () => {
  assert.equal(accountSummary([]), null);
  assert.equal(accountSummary(undefined), null);
});
