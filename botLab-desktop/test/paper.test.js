// paper.test.js — deterministic checks on the forward accrual engine + persistence.
// Cross-validates the per-second/per-hour accrual against the annualized() APR identity.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPosition, accrue, closePosition, positionSummary, legModel } from "../src/engine/paper.js";
import { savePositions, loadPositions, writeCache, readCache, saveSettings, loadSettings } from "../src/engine/store.js";
import { roundTripCost } from "../src/engine/costs.js";

const HOUR = 3600 * 1000;
const BASE = 1699999200000; // hour-aligned epoch ms
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) < tol, `${label}: got ${a}, want ${b} (+/-${tol})`);

test("legModel maps strategy/config to legs correctly", () => {
  assert.deepEqual(legModel("two", "A"), { gmxSide: "short", hlPerHourSign: -1 });
  assert.deepEqual(legModel("two", "B"), { gmxSide: "long", hlPerHourSign: +1 });
  assert.deepEqual(legModel("one", null), { gmxSide: "short", hlPerHourSign: 0 });
});

test("two-leg A: 1h continuous GMX + one HL settlement matches the APR identity", () => {
  const p = openPosition({ strategy: "two", instrumentKey: "APT", config: "A", capital: 100000, leverage: 1, nowMs: BASE });
  // f_short=1e-8/s (short receives), b_short=0, hl_rate=1e-5/hr. Over exactly 1h from an hour boundary:
  //   GMX funding = 1e-8*3600*100000 = +3.6 ; HL (config A long leg) = -1 * 1e-5 * 100000 = -1.0
  const pt = accrue(p, { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 0, hl_rate: 1e-5 }, BASE + HOUR);
  near(pt.cum, 2.6, 1e-9, "1h cum P&L (3.6 GMX - 1.0 HL)");
  assert.equal(p.accruals[0].hlSettlements, 1, "exactly one HL settlement crossed");
  near(p.accruals[0].dPnlGmx, 3.6, 1e-9, "GMX leg");
  near(p.accruals[0].dPnlHl, -1.0, 1e-9, "HL leg");
});

test("HL settles only when a top-of-hour boundary is crossed", () => {
  const p = openPosition({ strategy: "two", instrumentKey: "APT", config: "A", capital: 100000, leverage: 1, nowMs: BASE + 10 * 60 * 1000 });
  const snap = { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 0, hl_rate: 1e-5 };
  // +30min (10->40 past the hour): no boundary crossed
  accrue(p, snap, BASE + 40 * 60 * 1000);
  assert.equal(p.accruals[0].hlSettlements, 0, "no HL settlement mid-hour");
  // advance past the next hour boundary: one settlement
  accrue(p, snap, BASE + 70 * 60 * 1000);
  assert.equal(p.accruals[1].hlSettlements, 1, "one HL settlement after crossing the hour");
});

test("one-leg: continuous GMX net (fund - borrow), no HL", () => {
  const p = openPosition({ strategy: "one", instrumentKey: "ETH-Arb", capital: 100000, leverage: 1, nowMs: BASE });
  const pt = accrue(p, { f_short: 1e-8, b_short: 2e-9, f_long: 0, b_long: 0, hl_rate: 0 }, BASE + HOUR);
  near(pt.cum, (1e-8 - 2e-9) * 3600 * 100000, 1e-9, "one-leg 1h net");
  assert.equal(p.accruals[0].dPnlHl, 0, "no HL leg");
});

test("invalid snapshot does not accrue and does not advance time", () => {
  const p = openPosition({ strategy: "two", instrumentKey: "APT", config: "A", capital: 1000, leverage: 1, nowMs: BASE });
  const r = accrue(p, { f_long: NaN, f_short: NaN, b_long: 0, b_short: 0, hl_rate: 1e-5 }, BASE + HOUR);
  assert.equal(r, null, "no point produced");
  assert.equal(p.lastAccrualAt, BASE, "time not advanced on bad data");
  assert.equal(p.cumFunding, 0, "no accrual");
});

test("positionSummary computes net (gross - round-trip) and annualized APR", () => {
  const rt = roundTripCost({}, 100000, false); // two-leg
  near(rt, 100000 * 0.0031 + 1, 1e-6, "two-leg round-trip cost");
  const p = openPosition({ strategy: "two", instrumentKey: "APT", config: "A", capital: 100000, leverage: 1, nowMs: BASE, roundTripCost: rt });
  accrue(p, { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 0, hl_rate: 1e-5 }, BASE + HOUR);
  const s = positionSummary(p);
  near(s.grossPnl, 2.6, 1e-9, "gross");
  near(s.netPnl, 2.6 - rt, 1e-9, "net = gross - round-trip");
  near(s.hoursElapsed, 1, 1e-9, "1 hour elapsed");
  // apr = (netPnl/capital) * (8760/hours)
  near(s.apr, (s.netPnl / 100000) * 8760, 1e-9, "annualized APR");
});

test("persistence: positions + settings + CSV cache survive a round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "fa-store-"));
  try {
    const p = openPosition({ strategy: "two", instrumentKey: "APT", config: "A", capital: 5000, leverage: 10, nowMs: BASE });
    accrue(p, { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 0, hl_rate: 1e-5 }, BASE + HOUR);
    closePosition(p, BASE + 2 * HOUR);
    savePositions(dir, [p]);
    const back = loadPositions(dir);
    assert.equal(back.length, 1);
    assert.equal(back[0].id, p.id);
    assert.equal(back[0].status, "closed");
    near(back[0].cumFunding, p.cumFunding, 1e-9, "cum survives");
    assert.equal(back[0].accruals.length, 1, "ledger survives");

    saveSettings(dir, { cap: 5000, lev: 10, asset: "APT" });
    assert.equal(loadSettings(dir).lev, 10);

    const rows = [{ ts: "2026-01-01 00:00:00+00:00", f_long: -1e-8, f_short: 1e-8, b_long: 1e-9, b_short: 0, hl_rate: 1e-5, hl_premium: -1e-4 }];
    writeCache(dir, "APT", rows);
    const cached = readCache(dir, "APT");
    assert.equal(cached.length, 1);
    near(cached[0].f_short, 1e-8, 1e-30, "cached factor round-trips");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
