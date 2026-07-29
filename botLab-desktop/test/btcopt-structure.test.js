// btcopt-structure.test.js — golden numbers for the «BTC-опционы» 4-leg winged-straddle structure
// builder + net-greek/debit aggregators (src/engine/btcopt/structure.js). Pure & deterministic; the
// chain/snapshot fixtures are crafted INLINE (no fixtures files). Market deltas & marks are the audited
// Strategy One reference values.
import test from "node:test";
import assert from "node:assert/strict";
import { buildStructure, optionDeltaTotal, netGreeks, netDebit, validateStructure } from "../src/engine/btcopt/structure.js";

const near = (a, b, tol, l) => assert.ok(Math.abs(a - b) < tol, `${l}: got ${a} want ${b}`);

const EXP = 1790000000000;

// The four resolved leg instruments: ATM straddle at 61000, short wings at 67000 / 55000.
const ATM_C = "BTC_USDC-30JUL26-61000-C";
const ATM_P = "BTC_USDC-30JUL26-61000-P";
const OTM_C = "BTC_USDC-30JUL26-67000-C";
const OTM_P = "BTC_USDC-30JUL26-55000-P";

// A canonical leg snapshot carrying the audited market greeks/marks.
const legSnap = (instrument, type, strike, g) => ({
  instrument, type, strike, expiryMs: EXP,
  bid: g.mark - 5, ask: g.mark + 5, mark: g.mark, markIv: 55,
  delta: g.delta, gamma: g.gamma, vega: g.vega, theta: g.theta, rho: 0,
  underlying: 61000, index: 61000,
  contractSize: 1, tickSize: 5, minTradeAmount: 0.01, markInUsd: true, ts: 1,
});

const snapshot = {
  ts: 1, underlying: 61000, index: 61000,
  legs: {
    [ATM_C]: legSnap(ATM_C, "call", 61000, { delta: 0.0487, gamma: 0.00012, vega: 60, theta: -45, mark: 425 }),
    [ATM_P]: legSnap(ATM_P, "put", 61000, { delta: -0.0512, gamma: 0.00013, vega: 62, theta: -44, mark: 410 }),
    [OTM_C]: legSnap(OTM_C, "call", 67000, { delta: 0.0005, gamma: 0.00001, vega: 8, theta: -5, mark: 30 }),
    [OTM_P]: legSnap(OTM_P, "put", 55000, { delta: -0.0011, gamma: 0.00002, vega: 9, theta: -6, mark: 28 }),
  },
  perp: null, liquidity: null, fresh: { ok: true }, errors: [],
};

// A hand-built structure whose legs reference the snapshot instruments (sides long,long,short,short).
const leg = (instrument, type, side, strike, entryMark) => ({
  instrument, type, side, strike, expiryMs: EXP,
  qtyAbs: 1, qtySigned: side === "long" ? 1 : -1,
  entryMark, contractSize: 1, minTradeAmount: 0.01, tickSize: 5, markInUsd: true,
});

const structure = {
  expiryMs: EXP,
  params: { callOffsetPct: 10, putOffsetPct: 10, qty: 1, execStyle: "limit" },
  strikes: { atm: 61000, kc: 67000, kp: 55000 },
  legs: [
    leg(ATM_C, "call", "long", 61000, 425),
    leg(ATM_P, "put", "long", 61000, 410),
    leg(OTM_C, "call", "short", 67000, 30),
    leg(OTM_P, "put", "short", 55000, 28),
  ],
  entryDebitUsd: 777,
  entryUnderlying: 61000,
};

test("optionDeltaTotal = Σ qtySigned·delta = 0.0487 − 0.0512 − 0.0005 + 0.0011 = −0.0019", () => {
  near(optionDeltaTotal(structure, snapshot), -0.0019, 1e-9, "optionDeltaTotal");
});

test("netGreeks sums each greek by signed qty (delta/gamma/vega/theta)", () => {
  const g = netGreeks(structure, snapshot);
  near(g.delta, -0.0019, 1e-9, "delta");
  near(g.gamma, 0.00022, 1e-9, "gamma"); // 0.00012 + 0.00013 − 0.00001 − 0.00002
  near(g.vega, 105, 1e-9, "vega"); // 60 + 62 − 8 − 9
  near(g.theta, -78, 1e-9, "theta"); // −45 − 44 + 5 + 6
});

test("netDebit = Σ qtySigned·mark·contractSize = 425 + 410 − 30 − 28 = 777", () => {
  near(netDebit(structure, snapshot).debitUsd, 777, 1e-9, "debitUsd");
});

// --- buildStructure ---------------------------------------------------------------------------------
// Chain: both a call & a put at every 1000-strike from 54000..70000 (one expiry). 67100 & 54900 are NOT
// listed, so the nearest-listed logic must snap kc→67000 and kp→55000.
const chain = [];
for (let k = 54000; k <= 70000; k += 1000) {
  for (const [ot, cp] of [["call", "C"], ["put", "P"]]) {
    chain.push({
      instrument_name: `BTC_USDC-30JUL26-${k}-${cp}`,
      option_type: ot,
      strike: k,
      expiration_timestamp: EXP,
      contract_size: 1,
      tick_size: 5,
      min_trade_amount: 0.01,
    });
  }
}

const quote = (mark) => ({ mark, contractSize: 1, minTradeAmount: 0.01, tickSize: 5, markInUsd: true });
const buildSnap = {
  ts: 1, underlying: 61000, index: 61000,
  legs: { [ATM_C]: quote(425), [ATM_P]: quote(410), [OTM_C]: quote(30), [OTM_P]: quote(28) },
  perp: null, liquidity: null, fresh: {}, errors: [],
};
const openParams = { expiry: EXP, callOffsetPct: 10, putOffsetPct: 10, qty: 1, execStyle: "limit" };

test("buildStructure resolves atm/kc/kp via nearest-listed and builds the 4 signed legs", () => {
  const st = buildStructure(openParams, chain, buildSnap);
  assert.equal(st.error, undefined);
  assert.equal(st.expiryMs, EXP);
  assert.deepEqual(st.strikes, { atm: 61000, kc: 67000, kp: 55000 });
  assert.equal(st.legs.length, 4);

  const [c0, c1, c2, c3] = st.legs;
  assert.equal(c0.instrument, ATM_C); assert.equal(c0.type, "call"); assert.equal(c0.side, "long"); assert.equal(c0.qtySigned, 1);
  assert.equal(c1.instrument, ATM_P); assert.equal(c1.type, "put"); assert.equal(c1.side, "long"); assert.equal(c1.qtySigned, 1);
  assert.equal(c2.instrument, OTM_C); assert.equal(c2.type, "call"); assert.equal(c2.side, "short"); assert.equal(c2.qtySigned, -1);
  assert.equal(c3.instrument, OTM_P); assert.equal(c3.type, "put"); assert.equal(c3.side, "short"); assert.equal(c3.qtySigned, -1);

  near(st.entryDebitUsd, 777, 1e-9, "entryDebitUsd"); // 425 + 410 − 30 − 28
  assert.equal(st.entryUnderlying, 61000);
  assert.deepEqual(st.params, { callOffsetPct: 10, putOffsetPct: 10, qty: 1, execStyle: "limit" });
});

test("buildStructure accepts the { instruments:[...] } chain envelope too", () => {
  const st = buildStructure(openParams, { instruments: chain }, buildSnap);
  assert.equal(st.error, undefined);
  assert.equal(st.strikes.atm, 61000);
});

test("buildStructure returns a Russian error when the expiry has no options", () => {
  const st = buildStructure({ ...openParams, expiry: EXP + 1 }, chain, buildSnap);
  assert.ok(st.error && typeof st.error === "string");
  assert.equal(st.legs, undefined);
});

test("buildStructure returns a Russian error when the snapshot has no underlying", () => {
  const st = buildStructure(openParams, chain, { legs: {} });
  assert.ok(st.error && typeof st.error === "string");
});

// --- validateStructure ------------------------------------------------------------------------------
const metaByInstrument = Object.fromEntries(chain.map((m) => [m.instrument_name, m])); // min_trade_amount 0.01
const buildAt = (qty) => buildStructure({ ...openParams, qty }, chain, { underlying: 61000, legs: {} });

test("validateStructure: qty 0.005 (< min lot 0.01) → ok:false", () => {
  const r = validateStructure(buildAt(0.005), metaByInstrument);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test("validateStructure: qty 0.015 (not a whole multiple of 0.01) → ok:false", () => {
  const r = validateStructure(buildAt(0.015), metaByInstrument);
  assert.equal(r.ok, false);
});

test("validateStructure: qty 0.02 (on the lot grid) → ok:true", () => {
  const r = validateStructure(buildAt(0.02), metaByInstrument);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateStructure: a leg with a mismatched expiryMs → ok:false", () => {
  const s = buildAt(0.02);
  s.legs[3] = { ...s.legs[3], expiryMs: EXP + 86400000 };
  const r = validateStructure(s, metaByInstrument);
  assert.equal(r.ok, false);
});
