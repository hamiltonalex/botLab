// btcopt-engine.test.js — «BTC-опционы» engine integration: create → openStructure → ingest → evaluate
// produces the full §5 cycle-snapshot deterministically, executes a paper hedge, and closes cleanly.
// Pure engine test (no Electron/network); the market snapshot is crafted inline to hit the spec numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as engine from "../src/engine/btcopt/engine.js";

const near = (a, b, tol, l) => assert.ok(Math.abs(a - b) < tol, `${l}: got ${a} want ${b} (±${tol})`);

const EXPIRY = Date.UTC(2026, 6, 17, 8, 0, 0); // 17JUL26 08:00 UTC
const NOON = Date.UTC(2026, 6, 15, 12, 0, 0); // non-blackout, 2 days before expiry
const nm = (strike, type) => `BTC_USDC-TEST-${strike}-${type === "call" ? "C" : "P"}`;

// A small live chain (metas) across a strike ladder, one expiry — the get_instruments shape.
function mkChain() {
  const metas = [];
  for (const strike of [55000, 58000, 61000, 64000, 67000]) {
    for (const type of ["call", "put"]) {
      metas.push({
        instrument_name: nm(strike, type),
        option_type: type,
        strike,
        expiration_timestamp: EXPIRY,
        contract_size: 1,
        tick_size: 5,
        min_trade_amount: 0.01,
      });
    }
  }
  return metas;
}

// A composite snapshot: the 4 winged-straddle legs carry the spec's worked-example greeks (so the net
// option delta is exactly −0.0019 at unit qty), plus the inverse perp + liquidity.
function mkSnapshot(ts = 1_700_000_000_000) {
  const leg = (strike, type, o) => [nm(strike, type), { instrument: nm(strike, type), strike, type, contractSize: 1, tickSize: 5, minTradeAmount: 0.01, markInUsd: true, underlying: 61000, index: 61000, ...o }];
  const legs = Object.fromEntries([
    leg(61000, "call", { mark: 425, bid: 420, ask: 430, markIv: 52.4, delta: 0.0487, gamma: 0.004, vega: 3.1, theta: -1.9 }),
    leg(61000, "put", { mark: 410, bid: 405, ask: 415, markIv: 52.1, delta: -0.0512, gamma: 0.004, vega: 3.0, theta: -1.8 }),
    leg(67000, "call", { mark: 30, bid: 28, ask: 32, markIv: 55.6, delta: 0.0005, gamma: 0.001, vega: 1.0, theta: -0.5 }),
    leg(55000, "put", { mark: 28, bid: 26, ask: 30, markIv: 58.1, delta: -0.0011, gamma: 0.001, vega: 0.9, theta: -0.4 }),
  ]);
  return {
    ts,
    underlying: 61000,
    index: 61000,
    legs,
    perp: { instrument: "BTC-PERPETUAL", mark: 61000, index: 61000, bid: 60999, ask: 61001, funding8h: 0.0001, inverse: true, contractSize: 10, tickSize: 0.5, minTradeAmount: 10 },
    liquidity: { bid: 60999, ask: 61001, mid: 61000, halfSpread: 1 },
    fresh: { ageSec: 0, stale: false, ok: true, gateOk: true, source: "deribit-rest", testnet: false, notes: [] },
    errors: [],
  };
}

const PARAMS = { expiry: EXPIRY, callOffsetPct: 10, putOffsetPct: 10, qty: 1, execStyle: "limit" };

// A fresh engine with the structure opened at NOON.
function opened() {
  const st = engine.create({ nowMs: NOON });
  const snap = mkSnapshot();
  const r = engine.openStructure(st, PARAMS, mkChain(), snap, NOON);
  assert.equal(r.ok, true, r.error);
  return { st, snap };
}

test("openStructure resolves ATM+wings, stamps id, validates, and books an open event", () => {
  const { st } = opened();
  assert.ok(st.structure, "structure set");
  assert.deepEqual(st.structure.strikes, { atm: 61000, kc: 67000, kp: 55000 }); // 67100→67000, 54900→55000
  assert.equal(st.structure.legs.map((l) => l.side).join(","), "long,long,short,short");
  near(st.structure.entryDebitUsd, 425 + 410 - 30 - 28, 1e-9, "entryDebit 777");
  assert.equal(st.structure.createdAt, NOON);
  assert.equal(st.ledger.length, 1);
  assert.equal(st.ledger[0].type, "open");
});

test("evaluate emits the full cycle-snapshot with the spec's net greeks (−0.0019) and a HEDGE decision", () => {
  const { st, snap } = opened();
  engine.ingest(st, snap, NOON);
  const cyc = engine.evaluate(st, snap, NOON);

  // net greeks reproduce the worked example exactly (unit qty)
  near(cyc.net_option_delta_bs, -0.0019, 1e-9, "net option delta");
  near(cyc.net_gamma, 0.006, 1e-9, "net gamma");
  near(cyc.net_vega, 4.2, 1e-9, "net vega");
  near(cyc.net_theta, -2.8, 1e-9, "net theta");
  near(cyc.net_debit, 777, 1e-9, "net debit");

  // cycle shape: every §5 field present
  for (const k of [
    "ts", "underlying_price", "index_price", "structure_id", "option_legs", "net_option_delta_bs",
    "total_delta_bs", "current_futures_delta", "perp_position", "exchange_delta_total",
    "target_futures_delta", "hedge_deadband_btc", "delta_excess", "trigger_reason", "estimated_cost",
    "estimated_benefit", "decision", "hedge_order", "account", "pnl", "blackout", "gate", "payoff",
  ]) assert.ok(k in cyc, `cycle missing field: ${k}`);

  assert.equal(cyc.option_legs.length, 4);
  assert.equal(cyc.current_futures_delta, 0, "pre-fill futures delta is 0 (matches the sample JSON)");
  near(cyc.delta_excess, 0.0009, 1e-9, "|−0.0019| − 0.001 deadband");
  near(cyc.target_futures_delta, 0.0019, 1e-9, "−net_option_delta_bs");
  assert.deepEqual(cyc.trigger_reason, ["delta"]);
  assert.equal(cyc.decision, "HEDGE");
  assert.equal(cyc.hedge_order.side, "buy");
  assert.equal(cyc.hedge_order.order_type, "limit");
  assert.equal(cyc.hedge_order.post_only, true);

  // account: equity = deposit + net (≈0 at open, marks == entry marks); initial margin ≈ net debit
  near(cyc.account.equity, 100, 1e-6, "equity ≈ deposit");
  near(cyc.account.initial_margin, 777, 1e-9, "defined-risk margin ≈ debit");

  // payoff geometry present
  assert.ok(Array.isArray(cyc.payoff.pts) && cyc.payoff.pts.length === 96);
  near(cyc.payoff.minPi, -777, 1e-9, "min payoff = −D at S=K");
});

test("the HEDGE fill is a side-effect that takes effect on the NEXT tick (pre-fill snapshot)", () => {
  const { st, snap } = opened();
  engine.ingest(st, snap, NOON);
  const cyc = engine.evaluate(st, snap, NOON);
  assert.equal(cyc.decision, "HEDGE");
  // The paper fill executed: −0.0019 BTC of short-delta neutralized by +12 inverse contracts.
  assert.equal(st.perpState.qty, 12, "perp filled to +12 contracts (round(0.001967·61001/10))");
  assert.equal(st.ledger.length, 2, "open + hedge events");
  assert.equal(st.ledger[1].type, "hedge");
  // The cycle's last_hedge reflects the just-executed hedge even though position fields were pre-fill.
  assert.ok(cyc.last_hedge && cyc.last_hedge.side === "buy");
});

test("after hedging, the residual delta rounds to 0 contracts → SKIP (no spurious re-hedge)", () => {
  const { st, snap } = opened();
  engine.ingest(st, snap, NOON);
  engine.evaluate(st, snap, NOON); // first tick hedges → qty 12
  // A minute later the time trigger fires, but residual delta (−0.0019 + 0.001967 ≈ 6.7e-5) rounds to 0.
  const later = NOON + 61_000;
  engine.ingest(st, snap, later);
  const cyc2 = engine.evaluate(st, snap, later);
  assert.ok(cyc2.trigger_reason.includes("time"), "time trigger armed");
  assert.equal(cyc2.decision, "SKIP", "but the residual rounds to 0 contracts");
  assert.equal(st.perpState.qty, 12, "position unchanged");
  near(cyc2.current_futures_delta, (12 * 10) / 61000, 1e-9, "futures delta now reflects the +12 contracts");
});

test("evaluate is deterministic: identical inputs → deepEqual cycles", () => {
  const a = opened();
  engine.ingest(a.st, a.snap, NOON);
  const cycA = engine.evaluate(a.st, a.snap, NOON);
  const b = opened();
  engine.ingest(b.st, b.snap, NOON);
  const cycB = engine.evaluate(b.st, b.snap, NOON);
  assert.deepEqual(cycA, cycB);
});

test("settlement blackout: evaluating in the 08:00 UTC window yields decision BLACKOUT, no fill", () => {
  const { st, snap } = opened();
  const eightUtc = Date.UTC(2026, 6, 15, 8, 0, 0);
  engine.ingest(st, snap, eightUtc);
  const cyc = engine.evaluate(st, snap, eightUtc);
  assert.equal(cyc.decision, "BLACKOUT");
  assert.equal(cyc.blackout.active, true);
  assert.equal(cyc.hedge_order, null);
  assert.equal(st.perpState.qty, 0, "no fill during blackout");
});

test("closeStructure flattens the perp, locks in option MtM, and preserves cumulative P&L", () => {
  const { st, snap } = opened();
  engine.ingest(st, snap, NOON);
  engine.evaluate(st, snap, NOON); // hedge → qty 12
  assert.equal(st.perpState.qty, 12);

  const r = engine.closeStructure(st, snap, NOON + 120_000);
  assert.equal(r.ok, true);
  assert.equal(st.structure, null, "structure cleared");
  assert.equal(st.perpState.qty, 0, "perp flattened");
  assert.ok(st.ledger.some((e) => e.type === "close-perp"));
  assert.ok(st.ledger.some((e) => e.type === "close-options"));

  // A post-close evaluate is a clean idle cycle; cumulative P&L survives (realized options + perp − fees).
  const cyc = engine.evaluate(st, snap, NOON + 121_000);
  assert.equal(cyc.structure_id, null);
  assert.equal(cyc.option_legs.length, 0);
  assert.equal(cyc.decision, "SKIP");
  assert.ok(Number.isFinite(cyc.pnl.net_total), "net P&L still defined after close");
});

test("greeks gate: a snapshot with gateOk=false pauses hedging (SKIP, no fill)", () => {
  const { st } = opened();
  const bad = mkSnapshot();
  bad.fresh.gateOk = false;
  engine.ingest(st, bad, NOON);
  const cyc = engine.evaluate(st, bad, NOON);
  assert.equal(cyc.decision, "SKIP");
  assert.equal(cyc.gate.ok, false);
  assert.equal(st.perpState.qty, 0, "no fill when the greeks gate is closed");
});
