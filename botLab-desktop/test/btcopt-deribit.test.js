// btcopt-deribit.test.js — the greeks gate (pure part of deribit.js). The load-bearing case: a
// primary (open-structure) leg whose fetch failed entirely is ABSENT from the legs map — the gate
// must fail on the missing name, not pass on the valid survivors (a missing leg's delta would
// otherwise silently count as 0 and the engine would hedge off an understated net delta).
// PURE, inline fixtures, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { greeksGateOk } from "../src/engine/btcopt/deribit.js";

const leg = (over = {}) => ({ delta: 0.5, gamma: 0.0001, vega: 12, theta: -30, mark: 900, ...over });

test("greeks gate: every required leg present with finite greeks → true", () => {
  const legs = { A: leg(), B: leg({ delta: -0.5 }) };
  assert.equal(greeksGateOk(legs, ["A", "B"]), true);
});

test("greeks gate: a required leg MISSING from the snapshot → false (fetch-failed leg pauses hedging)", () => {
  const legs = { A: leg(), B: leg(), C: leg() }; // D never came back
  assert.equal(greeksGateOk(legs, ["A", "B", "C", "D"]), false);
});

test("greeks gate: a present leg with a non-finite greek → false (existing behaviour kept)", () => {
  assert.equal(greeksGateOk({ A: leg(), B: leg({ vega: null }) }, ["A", "B"]), false);
  assert.equal(greeksGateOk({ A: leg({ mark: NaN }) }, ["A"]), false);
});

test("greeks gate: empty required list → true (flat, band-only polling gates nothing)", () => {
  assert.equal(greeksGateOk({ A: leg({ delta: null }) }, []), true);
});

test("greeks gate: legacy 1-arg form validates whatever is present (empty map → true)", () => {
  assert.equal(greeksGateOk({}), true);
  assert.equal(greeksGateOk({ A: leg() }), true);
  assert.equal(greeksGateOk({ A: leg({ theta: undefined }) }), false);
});

// ── greeksGateFailures: the culprit list the ticket names ────────────────────────────────────────
// The boolean gate is DEFINED as failures.length === 0, so these tests also pin the equivalence.
import { greeksGateFailures } from "../src/engine/btcopt/deribit.js";

test("gate failures: full greeks → empty list", () => {
  assert.deepEqual(greeksGateFailures({ A: leg(), B: leg() }, ["A", "B"]), []);
});

test("gate failures: names the MISSING required leg (fetch-failed)", () => {
  assert.deepEqual(greeksGateFailures({ A: leg(), B: leg() }, ["A", "B", "D"]), ["D"]);
});

test("gate failures: names a PRESENT leg with a non-finite greek or mark", () => {
  assert.deepEqual(greeksGateFailures({ A: leg(), B: leg({ vega: null }) }, ["A", "B"]), ["B"]);
  assert.deepEqual(greeksGateFailures({ A: leg({ mark: NaN }) }, ["A"]), ["A"]);
});

test("gate failures: order follows requiredNames; band legs outside required never appear", () => {
  const legs = { A: leg({ delta: null }), BAND: leg({ mark: NaN }), C: leg() };
  assert.deepEqual(greeksGateFailures(legs, ["C", "A"]), ["A"]); // BAND is not required → not blamed
});

test("gate failures: empty required list → [] (flat, band-only polling gates nothing)", () => {
  assert.deepEqual(greeksGateFailures({ A: leg({ delta: null }) }, []), []);
});

test("gate ok ≡ (failures.length === 0) across the fixture matrix", () => {
  const cases = [
    [{ A: leg(), B: leg() }, ["A", "B"]],
    [{ A: leg() }, ["A", "B"]],
    [{ A: leg({ theta: undefined }) }, null],
    [{}, null],
    [{ A: leg({ delta: null }) }, []],
  ];
  for (const [legs, req] of cases) {
    assert.equal(greeksGateOk(legs, req), greeksGateFailures(legs, req).length === 0);
  }
});
