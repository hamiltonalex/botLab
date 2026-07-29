// btcopt-payoff.test.js — golden payoff geometry for the «BTC-опционы» 4-leg winged-straddle "tent"
// (src/engine/btcopt/payoff.js). Pure; the structure fixture is crafted INLINE. Reproduces the strategy's
// reference payoff points, break-evens and the capped plateau exactly.
import test from "node:test";
import assert from "node:assert/strict";
import { payoffAt, breakEvens, payoffCurve } from "../src/engine/btcopt/payoff.js";

const near = (a, b, tol, l) => assert.ok(Math.abs(a - b) < tol, `${l}: got ${a} want ${b}`);

const EXP = 1790000000000;
const legPos = (type, side, strike) => ({
  instrument: `${type}-${strike}`, type, side, strike, expiryMs: EXP,
  qtyAbs: 1, qtySigned: side === "long" ? 1 : -1, entryMark: null,
  contractSize: 1, minTradeAmount: 0.01, tickSize: 5, markInUsd: true,
});

const structure = {
  expiryMs: EXP,
  params: { callOffsetPct: 10, putOffsetPct: 10, qty: 1, execStyle: "limit" },
  strikes: { atm: 61000, kc: 67100, kp: 54900 },
  legs: [
    legPos("call", "long", 61000),
    legPos("put", "long", 61000),
    legPos("call", "short", 67100),
    legPos("put", "short", 54900),
  ],
  entryDebitUsd: 3000,
  entryUnderlying: 61000,
};

test("payoffAt reproduces the winged-straddle tent points exactly", () => {
  near(payoffAt(structure, 50000), 3100, 1e-9, "S=50000 (lower plateau)");
  near(payoffAt(structure, 54900), 3100, 1e-9, "S=54900 (=Kp)");
  near(payoffAt(structure, 58000), 0, 1e-9, "S=58000 (lower break-even)");
  near(payoffAt(structure, 61000), -3000, 1e-9, "S=61000 (=K, floor = −D)");
  near(payoffAt(structure, 64000), 0, 1e-9, "S=64000 (upper break-even)");
  near(payoffAt(structure, 67100), 3100, 1e-9, "S=67100 (=Kc)");
  near(payoffAt(structure, 70000), 3100, 1e-9, "S=70000 (upper plateau)");
});

test("breakEvens = [K − D/(q·cs), K + D/(q·cs)] = [58000, 64000]", () => {
  const [beDown, beUp] = breakEvens(structure);
  near(beDown, 58000, 1e-9, "beDown");
  near(beUp, 64000, 1e-9, "beUp");
});

test("breakEvens: a debit wider than a wing has NO break-even on that side (no phantom marker)", () => {
  // d = 8000 > both wing widths (K−Kp = Kc−K = 6100): the tent is capped below zero on both plateaus
  // (plateau = 6100 − 8000 = −1900) — the naive K±8000 points sit in the flat loss region.
  const expensive = { ...structure, entryDebitUsd: 8000 };
  assert.deepEqual(breakEvens(expensive), [null, null]);
  near(payoffAt(expensive, 53000), -1900, 1e-9, "naive lower BE point is NOT a zero crossing");

  // Asymmetric: narrow put wing (K−Kp = 5000), wide call wing (Kc−K = 6100), d = 5500 — only the
  // upper break-even is real; exactly-at-the-wing (d = 5000 = K−Kp) still counts (touches zero at Kp).
  const asym = { ...structure, strikes: { atm: 61000, kc: 67100, kp: 56000 }, entryDebitUsd: 5500 };
  assert.deepEqual(breakEvens(asym), [null, 66500]);
  assert.deepEqual(breakEvens({ ...asym, entryDebitUsd: 5000 }), [56000, 66000]);

  // A net credit (D < 0) never crosses zero from above — the whole tent is a gain.
  assert.deepEqual(breakEvens({ ...structure, entryDebitUsd: -100 }), [null, null]);
});

test("payoffCurve: n inclusive points, plateau 3100, minPi −3000, exposes K/Kc/Kp/D + break-evens", () => {
  const c = payoffCurve(structure, { min: 45000, max: 80000, n: 8 });
  assert.equal(c.pts.length, 8);
  assert.equal(c.pts[0].s, 45000);
  assert.equal(c.pts[c.pts.length - 1].s, 80000);
  near(c.plateau, 3100, 1e-9, "plateau");
  near(c.minPi, -3000, 1e-9, "minPi");
  assert.equal(c.K, 61000);
  assert.equal(c.Kc, 67100);
  assert.equal(c.Kp, 54900);
  assert.equal(c.D, 3000);
  near(c.breakEvens[0], 58000, 1e-9, "curve beDown");
  near(c.breakEvens[1], 64000, 1e-9, "curve beUp");
});
