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

// ── buildDeribitSnapshot health partition (audit №3): band failures must not degrade the primary
// verdict. Network is stubbed via global.fetch; the failing instrument costs one retry sleep (~1.5s).
import { buildDeribitSnapshot } from "../src/engine/btcopt/deribit.js";

function stubFetch(failName) {
  const envelope = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", result, usDiff: 1000 }) });
  const ticker = (name) =>
    name === "BTC-PERPETUAL"
      ? { mark_price: 61000, index_price: 61000, best_bid_price: 60999, best_ask_price: 61001, funding_8h: 0.0001, current_funding: 0.0001, timestamp: 1751500000000 }
      : { mark_price: 900, best_bid_price: 890, best_ask_price: 910, mark_iv: 45, index_price: 61000, underlying_price: 61000, timestamp: 1751500000000, greeks: { delta: 0.5, gamma: 0.0001, vega: 12, theta: -30, rho: 1 } };
  const meta = (name) =>
    name === "BTC-PERPETUAL"
      ? { instrument_name: name, instrument_type: "reversed", contract_size: 10, tick_size: 0.5, min_trade_amount: 10 }
      : { instrument_name: name, option_type: "call", strike: 61000, expiration_timestamp: 1752739200000, contract_size: 1, tick_size: 5, min_trade_amount: 0.01, quote_currency: "USDC", settlement_currency: "USDC" };
  return async (url) => {
    const u = new URL(String(url));
    const name = u.searchParams.get("instrument_name");
    if (name === failName) return { ok: false, status: 500, json: async () => ({}) };
    if (u.pathname.endsWith("/public/ticker")) return envelope(ticker(name));
    if (u.pathname.endsWith("/public/get_instrument")) return envelope(meta(name));
    return envelope({});
  };
}

test("snapshot: failed BAND leg → in errors/notes, primaryErrors empty, ok+gate stay true", async () => {
  const real = global.fetch;
  global.fetch = stubFetch("BAND-LEG");
  try {
    const snap = await buildDeribitSnapshot({ legInstruments: ["PRIM-LEG", "BAND-LEG"], primaryInstruments: ["PRIM-LEG"], nowMs: 1751500000000 });
    assert.ok(snap.errors.some((e) => e.instrument === "BAND-LEG"), "band failure recorded in errors");
    assert.equal(snap.primaryErrors.length, 0, "no primary errors");
    assert.equal(snap.fresh.ok, true, "primary verdict stays ok");
    assert.equal(snap.fresh.gateOk, true, "greeks gate unaffected");
    assert.ok(snap.fresh.notes.some((n) => n.includes("BAND-LEG")), "note names the band culprit");
  } finally {
    global.fetch = real;
  }
});

test("snapshot: failed PRIMARY leg → primaryErrors non-empty, ok false, gate fails on the name", async () => {
  const real = global.fetch;
  global.fetch = stubFetch("PRIM-LEG");
  try {
    const snap = await buildDeribitSnapshot({ legInstruments: ["PRIM-LEG", "BAND-LEG"], primaryInstruments: ["PRIM-LEG"], nowMs: 1751500000000 });
    assert.ok(snap.primaryErrors.some((e) => e.instrument === "PRIM-LEG"), "primary failure recorded");
    assert.equal(snap.fresh.ok, false, "primary verdict degrades");
    assert.deepEqual(snap.fresh.gateFailed, ["PRIM-LEG"], "gate names the missing primary leg");
  } finally {
    global.fetch = real;
  }
});
