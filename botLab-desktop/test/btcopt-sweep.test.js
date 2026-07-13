// btcopt-sweep.test.js — pure parameter sweep (Phase 3b): determinism, ranked-order property
// (marginOk partition → sharpe DESC → net tiebreak), EXACT metrics-reuse vs a manual engine replay,
// honest-data exclusions (unquoted wings), grid overrides, tiny-deposit ranking. PURE, inline
// fixtures (no fixture files, no network), explicit Date.UTC times.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as engine from "../src/engine/btcopt/engine.js";
import { summarize } from "../src/engine/btcopt/metrics.js";
import { runSweep } from "../src/engine/btcopt/sweep.js";

const EXPIRY = Date.UTC(2026, 6, 17, 8, 0, 0); // 17JUL26 08:00 UTC
const T0 = Date.UTC(2026, 6, 15, 12, 0, 0); // noon UTC — clear of the 08:00 settlement blackout
const STRIKES = [54400, 57600, 60800, 64000, 67200, 70400, 73600]; // 64000 ± 5/10/15% exactly
const nm = (strike, type) => `BTC_USDC-TEST-${strike}-${type === "call" ? "C" : "P"}`;

// One-expiry chain metas across the ladder — every wing the default grid can pick exists.
function mkChain() {
  const metas = [];
  for (const strike of STRIKES) {
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

// Deterministic quote model (smooth shapes, NOT a pricer): call delta = 0.5 + 0.5·tanh(6·(S−K)/S),
// put = call − 1 — the tanh curvature makes the winged straddle's net delta drift as S moves, so
// hedges genuinely fire; mark = intrinsic + time value (floor 30, decaying with |S−K|; ivBump adds
// a vol kicker). omitStrikes drops BOTH quotes at a strike (the chain meta stays) → honest-data tests.
function mkSnap(ts, underlying, ivBump = 0, omitStrikes = []) {
  const legs = {};
  for (const strike of STRIKES) {
    if (omitStrikes.includes(strike)) continue;
    const dCall = 0.5 + 0.5 * Math.tanh((6 * (underlying - strike)) / underlying);
    const tv = Math.max(30, 2500 + 40 * ivBump - 0.35 * Math.abs(underlying - strike));
    for (const type of ["call", "put"]) {
      const mark = Math.max(type === "call" ? underlying - strike : strike - underlying, 0) + tv;
      legs[nm(strike, type)] = {
        instrument: nm(strike, type), strike, type, contractSize: 1, tickSize: 5, minTradeAmount: 0.01,
        markInUsd: true, underlying, index: underlying,
        mark, bid: mark - 5, ask: mark + 5, markIv: 50 + ivBump,
        delta: type === "call" ? dCall : dCall - 1,
        gamma: 0.00001, vega: 2, theta: -1,
      };
    }
  }
  return {
    ts,
    underlying,
    index: underlying,
    legs,
    perp: { instrument: "BTC-PERPETUAL", mark: underlying, index: underlying, bid: underlying - 1, ask: underlying + 1, funding8h: 0.0001, inverse: true, contractSize: 10, tickSize: 0.5, minTradeAmount: 10 },
    liquidity: { bid: underlying - 1, ask: underlying + 1, mid: underlying, halfSpread: 1 },
    fresh: { ageSec: 0, stale: false, ok: true, gateOk: true, source: "deribit-rest", testnet: false, notes: [] },
    errors: [],
  };
}

// A moving path (~±1–2% steps, drifting up): enough delta excursion for hedges at every wing width.
const PATH = [64000, 64500, 63700, 65200, 64300, 66000, 65100, 66800, 66000, 67600, 66700, 68200];
const mkSeries = (omitStrikes = []) => PATH.map((u, i) => mkSnap(T0 + i * 300_000, u, 0, omitStrikes));

// qty 1 → realistic hedge sizes; equity 13000 splits marginOk by wing width at series[0] marks:
// short-leg IM totals ≈ 15560 (±5%) / 12680 (±10%) / 11900 (±15%) — only the ±5% wings exceed it.
const BASE = { qty: 1, paperEquityUsd: 13000 };

test("determinism: two identical runSweep calls → deepEqual results", () => {
  const args = () => ({ series: mkSeries(), chain: mkChain(), expiryMs: EXPIRY, baseSettings: { ...BASE } });
  assert.deepEqual(runSweep(args()), runSweep(args()));
});

test("shape + ranking: 108 combos, marginOk-first partition, sharpe DESC / net tiebreak in-group", () => {
  const r = runSweep({ series: mkSeries(), chain: mkChain(), expiryMs: EXPIRY, baseSettings: { ...BASE } });
  assert.equal(r.seriesLen, 12);
  assert.equal(r.objective, "sharpe");
  assert.equal(r.excluded.length, 0);
  assert.equal(r.combos.length, 108, "3 wings · 3 deadbands · 3 triggers · 4 lambdas");
  assert.equal(r.best, 0, "best indexes the ranked head");

  // combo shape — the documented keys, gridIndex stripped
  assert.deepEqual(
    Object.keys(r.combos[0]).sort(),
    ["deadbandBtc", "deadbandPreset", "hedges", "lambda", "marginOk", "maxDD", "net", "priceTriggerPct", "sharpe", "wingPct"],
  );

  // equity 13000 splits by wing width: ±5% IM ≈ 15560 (over) vs ±10/15% (under) — both groups present
  assert.ok(r.combos.every((c) => c.marginOk === (c.wingPct !== 5)), "marginOk ⇔ not the ±5% wings");
  const firstFalse = r.combos.findIndex((c) => !c.marginOk);
  assert.equal(firstFalse, 72, "all 72 marginOk:true combos precede the 36 marginOk:false");
  for (let i = firstFalse; i < r.combos.length; i++) assert.equal(r.combos[i].marginOk, false);

  // within each group: sharpe non-increasing; equal sharpe → net non-increasing
  for (let i = 1; i < r.combos.length; i++) {
    const p = r.combos[i - 1];
    const c = r.combos[i];
    if (p.marginOk !== c.marginOk) continue;
    assert.ok(p.sharpe >= c.sharpe, `sharpe order broken at ${i}: ${p.sharpe} < ${c.sharpe}`);
    if (p.sharpe === c.sharpe) assert.ok(p.net >= c.net, `net tiebreak broken at ${i}`);
  }

  assert.ok(r.combos.some((c) => c.hedges > 0), "the moving path makes some combos hedge");
});

test("metrics-reuse: the best combo's numbers equal a manual engine replay EXACTLY", () => {
  const series = mkSeries();
  const chain = mkChain();
  const r = runSweep({ series, chain, expiryMs: EXPIRY, baseSettings: { ...BASE } });
  const bc = r.combos[r.best];

  // Replay the same params through the raw engine lifecycle — no sweep involved.
  const st = engine.create({
    nowMs: series[0].ts,
    settings: {
      ...BASE,
      callOffsetPct: bc.wingPct,
      putOffsetPct: bc.wingPct,
      deadbandPreset: bc.deadbandPreset,
      deadbandBtc: bc.deadbandBtc,
      priceTriggerPct: bc.priceTriggerPct,
      lambda: bc.lambda,
    },
  });
  const opened = engine.openStructure(
    st,
    { expiry: EXPIRY, callOffsetPct: bc.wingPct, putOffsetPct: bc.wingPct, qty: st.settings.qty, execStyle: st.settings.execStyle },
    chain,
    series[0],
    series[0].ts,
  );
  assert.equal(opened.ok, true, opened.error);
  let cyc = engine.evaluate(st, series[0], series[0].ts);
  for (let i = 1; i < series.length; i++) {
    engine.ingest(st, series[i], series[i].ts);
    cyc = engine.evaluate(st, series[i], series[i].ts);
  }
  const m = summarize(st.metrics);
  assert.equal(bc.sharpe, m.sharpe, "sharpe is summarize()'s, bit-for-bit");
  assert.equal(bc.maxDD, m.maxDrawdown, "maxDD is summarize()'s maxDrawdown");
  assert.equal(bc.hedges, m.hedgeCount, "hedges is summarize()'s hedgeCount");
  assert.equal(bc.net, cyc.pnl.net_total, "net is the last cycle's pnl.net_total");
  assert.ok(bc.hedges > 0, "the best combo actually traded (non-degenerate replay)");
});

test("honest-data rule: snapshots without ±15%-wing quotes exclude every wingPct:15 combo", () => {
  const r = runSweep({ series: mkSeries([54400, 73600]), chain: mkChain(), expiryMs: EXPIRY, baseSettings: { ...BASE } });
  assert.equal(r.excluded.length, 36, "3 deadbands · 3 triggers · 4 lambdas at wing 15");
  for (const x of r.excluded) {
    assert.equal(x.wingPct, 15);
    assert.ok(typeof x.reason === "string" && x.reason.length > 0, "reason present");
    assert.ok(x.reason.includes(nm(73600, "call")) && x.reason.includes(nm(54400, "put")), "reason names the unquoted wings");
    assert.ok("deadbandPreset" in x && "deadbandBtc" in x && "priceTriggerPct" in x && "lambda" in x, "combo params echoed");
  }
  assert.equal(r.combos.length, 72, "grid size − excluded");
  assert.ok(r.combos.every((c) => c.wingPct !== 15), "no wing-15 combo was scored on guessed marks");
  assert.equal(r.best, 0);
});

test("grid override: one value per axis → exactly 1 combo; per-axis override merges over defaults", () => {
  const one = runSweep({
    series: mkSeries(),
    chain: { instruments: mkChain() }, // the { instruments } envelope shape works too
    expiryMs: EXPIRY,
    baseSettings: { ...BASE },
    grid: { wingPct: [10], deadband: [{ preset: "normal", btc: 0.001 }], priceTriggerPct: [1.0], lambda: [1.25] },
  });
  assert.equal(one.combos.length, 1);
  assert.equal(one.best, 0);
  assert.equal(one.excluded.length, 0);
  assert.deepEqual(
    (({ wingPct, deadbandPreset, deadbandBtc, priceTriggerPct, lambda }) => ({ wingPct, deadbandPreset, deadbandBtc, priceTriggerPct, lambda }))(one.combos[0]),
    { wingPct: 10, deadbandPreset: "normal", deadbandBtc: 0.001, priceTriggerPct: 1.0, lambda: 1.25 },
  );

  // overriding a single axis keeps the other defaults: 3 · 3 · 3 · 1 = 27
  const partial = runSweep({ series: mkSeries(), chain: mkChain(), expiryMs: EXPIRY, baseSettings: { ...BASE }, grid: { lambda: [1.5] } });
  assert.equal(partial.combos.length, 27);
  assert.ok(partial.combos.every((c) => c.lambda === 1.5));
});

test("paperEquityUsd 1 → every combo marginOk:false, still fully ranked, best = 0", () => {
  const r = runSweep({ series: mkSeries(), chain: mkChain(), expiryMs: EXPIRY, baseSettings: { qty: 1, paperEquityUsd: 1 } });
  assert.equal(r.combos.length, 108);
  assert.ok(r.combos.every((c) => c.marginOk === false), "min-size margin dwarfs a $1 deposit");
  assert.equal(r.best, 0);
  for (let i = 1; i < r.combos.length; i++) {
    const p = r.combos[i - 1];
    const c = r.combos[i];
    assert.ok(p.sharpe >= c.sharpe, `single-group sharpe DESC broken at ${i}`);
    if (p.sharpe === c.sharpe) assert.ok(p.net >= c.net, `net tiebreak broken at ${i}`);
  }
});

// ── Anti-drift coupling: the sweep's deadband axis IS the engine's canonical preset table ────────
import { DEADBAND_PRESETS } from "../src/engine/btcopt/engine.js";
import { defaultGrid } from "../src/engine/btcopt/sweep.js";

test("defaultGrid deadband axis derives from DEADBAND_PRESETS (toolbar and grid can't drift)", () => {
  assert.deepEqual(
    defaultGrid().deadband,
    Object.entries(DEADBAND_PRESETS).map(([preset, btc]) => ({ preset, btc })),
  );
});
