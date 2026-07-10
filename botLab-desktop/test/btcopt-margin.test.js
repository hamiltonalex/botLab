// btcopt-margin.test.js — golden Deribit STANDARD-MARGIN for the short winged-straddle legs (Phase 2c):
// LINEAR/USDC BTC formulas (0.15/0.10/0.075), per-leg sum, no netting; long legs contribute 0. PURE,
// inline fixtures. Numbers use the recorded-snapshot underlying/index (test/fixtures/deribit/live-snapshot).
import test from "node:test";
import assert from "node:assert/strict";
import { legMargin, structureMargin } from "../src/engine/btcopt/margin.js";

const near = (a, b, tol, l) => assert.ok(Math.abs(a - b) < tol, `${l}: got ${a} want ${b}`);
const U = 63872.5, IDX = 63861.83; // underlying, index

test("legMargin: short call ~10% OTM → floor binds → IM ≈ $63.9 / MM ≈ $47.9 (per 0.01)", () => {
  const r = legMargin({ type: "call", side: "short", strike: 70000, mark: 0.04, underlying: U, index: IDX, amount: 0.01 });
  near(r.im, 63.862, 1e-2, "IM = (max(0.054,0.10)·index + 0.04)·0.01");
  near(r.mm, 47.897, 1e-2, "MM = (0.075·index + 0.04)·0.01");
});

test("legMargin: short put floor = 0.10·strike, MM capped at strike → IM ≈ $58.0 / MM ≈ $43.5", () => {
  const r = legMargin({ type: "put", side: "short", strike: 58000, mark: 0.54, underlying: U, index: IDX, amount: 0.01 });
  near(r.im, 58.005, 1e-2, "IM = (max(reduced·index, 0.10·58000) + 0.54)·0.01 = (5800+0.54)·0.01");
  near(r.mm, 43.505, 1e-2, "MM = (0.075·min(index,58000) + 0.54)·0.01 = (4350+0.54)·0.01");
});

test("legMargin: long legs require no margin beyond premium", () => {
  assert.deepEqual(
    legMargin({ type: "call", side: "long", strike: 63000, mark: 900, underlying: U, index: IDX, amount: 0.01 }),
    { im: 0, mm: 0 },
  );
});

test("structureMargin: winged straddle = Σ short legs → IM ≈ $121.9 / MM ≈ $91.4 (breaches $100)", () => {
  const structure = {
    legs: [
      { instrument: "C-ATM", type: "call", side: "long", strike: 64000, entryMark: 900, qtyAbs: 0.01 },
      { instrument: "P-ATM", type: "put", side: "long", strike: 64000, entryMark: 880, qtyAbs: 0.01 },
      { instrument: "C-OTM", type: "call", side: "short", strike: 70000, entryMark: 0.04, qtyAbs: 0.01 },
      { instrument: "P-OTM", type: "put", side: "short", strike: 58000, entryMark: 0.54, qtyAbs: 0.01 },
    ],
  };
  const snapshot = { underlying: U, index: IDX, legs: { "C-OTM": { mark: 0.04 }, "P-OTM": { mark: 0.54 } } };
  const m = structureMargin(structure, snapshot);
  near(m.initial, 121.868, 5e-2, "IM total (long legs contribute 0)");
  near(m.maintenance, 91.402, 5e-2, "MM total");
  assert.ok(m.initial > 100, "the 0.01 straddle already breaches the $100 deposit under Standard Margin");
});

test("structureMargin: no structure / empty legs → zero requirement", () => {
  assert.deepEqual(structureMargin(null, { underlying: U, index: IDX }), { initial: 0, maintenance: 0 });
  assert.deepEqual(structureMargin({ legs: [] }, { underlying: U, index: IDX }), { initial: 0, maintenance: 0 });
});
