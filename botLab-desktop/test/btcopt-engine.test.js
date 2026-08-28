// btcopt-engine.test.js — «BTC-опционы» engine integration: create → openStructure → ingest → evaluate
// produces the full §5 cycle-snapshot deterministically, executes a paper hedge, and closes cleanly.
// Pure engine test (no Electron/network); the market snapshot is crafted inline to hit the spec numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as engine from "../src/engine/btcopt/engine.js";
import { effectiveDeadband } from "../src/engine/btcopt/hedge.js";
import { SELLHEDGE_DEFAULTS } from "../src/engine/otmscan/sellhedge.js";
import { legMargin } from "../src/engine/btcopt/margin.js";

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
  const st = engine.create({ nowMs: NOON, settings: { deadbandRefQty: 1 } });
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

  // account: equity = deposit + net (≈0 at open); REAL Deribit Standard margin on the two SHORT legs
  // (Phase 2c): short 67000-C (mark 30) IM 6130/MM 4605 + short 55000-P (mark 28) IM 5528/MM 4153.
  near(cyc.account.equity, 100, 1e-6, "equity ≈ deposit");
  near(cyc.account.initial_margin, 11658, 1e-9, "real IM = 6130 + 5528");
  near(cyc.account.maintenance_margin, 8758, 1e-9, "real MM = 4605 + 4153");
  assert.equal(cyc.account.over_deposit, true, "min-size structure's IM exceeds the $100 deposit");

  // payoff geometry present
  assert.ok(Array.isArray(cyc.payoff.pts) && cyc.payoff.pts.length === 96);
  near(cyc.payoff.minPi, -777, 1e-9, "min payoff = −D at S=K");
});

test("evaluate: cycle carries the 2a hedge_vs shadow (no_hedge_net ≡ options_upl)", () => {
  const { st, snap } = opened();
  engine.ingest(st, snap, NOON);
  const cyc = engine.evaluate(st, snap, NOON);
  assert.ok(cyc.hedge_vs, "hedge_vs present");
  near(cyc.hedge_vs.no_hedge_net, cyc.pnl.options_upl, 1e-9, "no_hedge_net = options_upl");
  near(cyc.hedge_vs.hedge_contribution, cyc.hedge_vs.hedged_net - cyc.hedge_vs.no_hedge_net, 1e-9, "contribution identity");
  assert.equal(typeof cyc.hedge_vs.helped, "boolean");
});

test("the HEDGE fill is a side-effect that takes effect on the NEXT tick (pre-fill snapshot)", () => {
  const { st, snap } = opened();
  engine.ingest(st, snap, NOON);
  const cyc = engine.evaluate(st, snap, NOON);
  assert.equal(cyc.decision, "HEDGE");
  // The paper fill executed: −0.0019 BTC of short-delta neutralized by +12 inverse contracts.
  assert.equal(st.perpState.qty, 12, "perp filled to +12 contracts (round(0.001967·61001/10))");
  // Ревизия 2026-08-25: тот же тик пересекает порог маржи ($100 депозита против MM ≈ $8.8k
  // стрэддла) и оставляет строку margin-alert ДО исполнения хеджа - счёт снимается до филла.
  assert.equal(st.ledger.length, 3, "open + margin-alert + hedge events");
  assert.equal(st.ledger[1].type, "margin-alert");
  assert.equal(st.ledger[2].type, "hedge");
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

// ── Expiry settlement (settleStructure + the evaluate() trigger) ────────────────────────────────
// The oracle: options settle at intrinsic, so the realized amount ≡ payoffAt(structure, S) — the
// same terminal tent the payoff chart promises (payoff.js).
import { payoffAt } from "../src/engine/btcopt/payoff.js";

// A post-expiry snapshot: option legs are GONE from the API (exactly what Deribit does), only the
// perp survives and carries the settlement-price proxy via its index.
function expiredSnapshot(S, ts = EXPIRY + 60_000) {
  return {
    ts,
    underlying: S,
    index: S,
    legs: {},
    perp: { instrument: "BTC-PERPETUAL", mark: S, index: S, bid: S - 1, ask: S + 1, funding8h: 0.0001, inverse: true, contractSize: 10, tickSize: 0.5, minTradeAmount: 10 },
    liquidity: { bid: S - 1, ask: S + 1, mid: S, halfSpread: 1 },
    fresh: { ageSec: 0, stale: false, ok: false, gateOk: false, gateFailed: [], source: "deribit-rest", testnet: false, notes: [] },
    errors: [],
  };
}

test("expiry settlement: evaluate() past expiry settles at intrinsic ≡ payoffAt, flattens the perp, books settle-options", () => {
  const { st, snap } = opened();
  engine.ingest(st, snap, NOON);
  engine.evaluate(st, snap, NOON); // hedge → qty 12
  assert.equal(st.perpState.qty, 12);
  const structure = st.structure;

  const S = 68_500; // beyond the 67000 wing → the plateau pays
  const expected = payoffAt(structure, S);
  const cyc = engine.evaluate(st, expiredSnapshot(S), EXPIRY + 60_000);

  assert.equal(st.structure, null, "structure settled away");
  assert.equal(st.perpState.qty, 0, "perp flattened at settlement");
  const settle = st.ledger.find((e) => e.type === "settle-options");
  assert.ok(settle, "settle-options row booked");
  near(settle.realizedUsd, expected, 1e-9, "settled amount ≡ payoffAt(S)");
  near(settle.priceRef, S, 1e-9, "settlement price recorded");
  near(st.realizedOptionsUsd, expected, 1e-9, "realizedOptionsUsd carries the terminal payoff");
  assert.ok(st.ledger.some((e) => e.type === "close-perp"), "perp exit booked");
  // the same tick already reports a FLAT book — no hedging of a dead structure
  assert.equal(cyc.structure_id, null);
  assert.equal(cyc.option_legs.length, 0);
});

test("expiry settlement: three tent points — plateau beyond the wing, −debit at ATM, between BE and wing", () => {
  for (const S of [70_000, 61_000, 64_000]) {
    const { st, snap } = opened();
    engine.evaluate(st, snap, NOON);
    const expected = payoffAt(st.structure, S);
    engine.evaluate(st, expiredSnapshot(S), EXPIRY + 1);
    const settle = st.ledger.find((e) => e.type === "settle-options");
    near(settle.realizedUsd, expected, 1e-9, `settled ≡ payoffAt(${S})`);
  }
  // sanity anchors of the tent itself (unit qty, debit 777):
  const { st } = opened();
  near(payoffAt(st.structure, 61_000), -777, 1e-9, "ATM pin loses exactly the debit");
  near(payoffAt(st.structure, 70_000), 6_000 - 777, 1e-9, "plateau = wing width − debit");
});

test("expiry settlement: a degraded tick (no index) does NOT settle; the next priced tick does", () => {
  const { st, snap } = opened();
  engine.evaluate(st, snap, NOON); // hedge → holds a perp
  const degraded = expiredSnapshot(61_000);
  degraded.index = null;
  degraded.underlying = null;
  engine.evaluate(st, degraded, EXPIRY + 60_000);
  assert.ok(st.structure, "no settlement on a garbage price");

  engine.evaluate(st, expiredSnapshot(61_000), EXPIRY + 120_000);
  assert.equal(st.structure, null, "settled on the next priced tick");
});

test("expiry settlement: a LATE settle (app closed over expiry) notes the lag", () => {
  const { st, snap } = opened();
  engine.evaluate(st, snap, NOON);
  engine.evaluate(st, expiredSnapshot(61_000, EXPIRY + 7_200_000), EXPIRY + 7_200_000); // +2h
  const settle = st.ledger.find((e) => e.type === "settle-options");
  assert.ok(settle.note.includes("поздний расчёт"), "late-settlement lag noted");
});

// ── lastRunMetrics: the finished run's summary survives the next open ───────────────────────────
test("lastRunMetrics: frozen at close, survives the next openStructure's metrics reset", () => {
  const { st, snap } = opened();
  engine.ingest(st, snap, NOON);
  engine.evaluate(st, snap, NOON);
  engine.evaluate(st, mkSnapshot(1_700_000_060_000), NOON + 60_000); // a second cycle → n ≥ 1
  const structureId = st.structure.id;

  engine.closeStructure(st, snap, NOON + 120_000);
  assert.ok(st.lastRunMetrics, "snapshot taken at close");
  assert.equal(st.lastRunMetrics.structureId, structureId);
  assert.equal(st.lastRunMetrics.openedAt, NOON);
  assert.equal(st.lastRunMetrics.closedAt, NOON + 120_000);
  assert.ok(Number.isFinite(st.lastRunMetrics.sharpe), "summary fields ride along");
  const frozen = { ...st.lastRunMetrics };

  // the next open resets state.metrics but must NOT touch the frozen snapshot
  const r = engine.openStructure(st, PARAMS, mkChain(), snap, NOON + 180_000);
  assert.equal(r.ok, true, r.error);
  assert.equal(st.metrics.n, 0, "run metrics reset at open");
  assert.deepEqual(st.lastRunMetrics, frozen, "lastRunMetrics untouched by the reset");

  // …and the cycle payload exposes it
  const cyc = engine.evaluate(st, snap, NOON + 180_000);
  assert.deepEqual(cyc.last_run_metrics, frozen);
});

test("lastRunMetrics: expiry settlement also freezes the finished run", () => {
  const { st, snap } = opened();
  engine.evaluate(st, snap, NOON);
  engine.evaluate(st, expiredSnapshot(64_000), EXPIRY + 1);
  assert.ok(st.lastRunMetrics, "settlement is an end-of-run too");
  assert.equal(st.lastRunMetrics.closedAt, EXPIRY + 1);
});

// ── Deadband presets: the canonical table and the normalize helper ──────────────────────────────
test("DEADBAND_PRESETS is the canonical table", () => {
  assert.deepEqual(engine.DEADBAND_PRESETS, { sellhedge: 0.0003, aggressive: 0.0005, normal: 0.001, conservative: 0.002 });
});

// Пресет продавца задан ЧЕРЕЗ КАЛИБРОВОЧНЫЙ РАЗМЕР, поэтому сырое число само по себе ничего не
// значит. Проверяется то, ради чего он заведён: на одном контракте полоса равна измеренным 0.03,
// то есть ровно bandBtc схемы из sellhedge.js. Эта связь и есть смысл пресета.
test("пресет продавца даёт на 1.0 контракта ровно полосу схемы (0.03 BTC)", () => {
  const w = engine.DEADBAND_PRESETS.sellhedge;
  const refQty = engine.defaultSettings().deadbandRefQty;
  near(effectiveDeadband({ deadbandBtc: w, structureQty: 1.0, refQty }), SELLHEDGE_DEFAULTS.bandBtc, 1e-12, "полоса на контракт");
  near(effectiveDeadband({ deadbandBtc: w, structureQty: 1.37, refQty }), 1.37 * SELLHEDGE_DEFAULTS.bandBtc, 1e-12, "масштаб размером");
  // и он ТЕСНЕЕ прежнего самого тесного: иначе заводить его было бы незачем
  assert.ok(w < engine.DEADBAND_PRESETS.aggressive);
});

test("normalizeDeadband: a bare preset gains the table width; explicit width always wins", () => {
  assert.deepEqual(engine.normalizeDeadband({ deadbandPreset: "aggressive" }), { deadbandPreset: "aggressive", deadbandBtc: 0.0005 });
  assert.deepEqual(
    engine.normalizeDeadband({ deadbandPreset: "conservative", deadbandBtc: 0.004 }),
    { deadbandPreset: "conservative", deadbandBtc: 0.004 }, // sweep-apply / custom grids pass through
  );
  assert.deepEqual(engine.normalizeDeadband({ deadbandPreset: "weird" }), { deadbandPreset: "weird" });
  assert.deepEqual(engine.normalizeDeadband({ lambda: 1.5 }), { lambda: 1.5 });
  assert.deepEqual(engine.normalizeDeadband(null), {});
});

// ── Execution style reaches the paper fill (price + fee) ────────────────────────────────────────
test("exec style: limit fills at MID with maker fee 0; market crosses the spread and pays taker", () => {
  // limit (default PARAMS/engineCfg): buy fills at liquidity.mid, fee 0
  const lim = opened();
  engine.evaluate(lim.st, lim.snap, NOON);
  const limFill = lim.st.ledger.find((e) => e.type === "hedge");
  assert.equal(limFill.priceRef, 61000, "limit fill at mid");
  near(limFill.feeUsd, 0, 1e-12, "maker fee 0.00%");

  // market: same book, execStyle market frozen at open via state.settings
  const st = engine.create({ nowMs: NOON, settings: { execStyle: "market", deadbandRefQty: 1 } });
  const snap = mkSnapshot();
  const r = engine.openStructure(st, { ...PARAMS, execStyle: "market" }, mkChain(), snap, NOON);
  assert.equal(r.ok, true, r.error);
  engine.evaluate(st, snap, NOON);
  const mktFill = st.ledger.find((e) => e.type === "hedge");
  assert.equal(mktFill.priceRef, 61001, "market buy crosses to the ask");
  near(mktFill.feeUsd, Math.abs(mktFill.contracts) * 10 * 0.0005, 1e-12, "taker 0.05%");
});

// ── Defaults must be expressible by the UI (audit №2: 3 s default vs the 5/15/30 toolbar) ────────
test("defaultSettings.repriceSec is the UI default 15 and one of the toolbar presets", () => {
  const s = engine.defaultSettings();
  assert.equal(s.repriceSec, 15, "engine default = UI default");
  assert.ok([5, 15, 30].includes(s.repriceSec), "default must be selectable in the toolbar");
});

// ── Close guard (audit №14): a held perp must not be orphaned by an unpriced-perp snapshot ───────
test("closeStructure refuses to close over a snapshot without a priced perp (no orphaned hedge)", () => {
  const { st, snap } = opened();
  engine.ingest(st, snap, NOON);
  engine.evaluate(st, snap, NOON); // hedge → perp position held
  assert.notEqual(st.perpState.qty, 0, "precondition: a perp hedge is held");

  const degraded = { ...snap, perp: null }; // perp fetch failed on this tick
  const r = engine.closeStructure(st, degraded, NOON + 120_000);
  assert.ok(r.error && r.error.includes("нет цены перпетуала"), r.error);
  assert.ok(st.structure, "structure still open — nothing was half-closed");
  assert.notEqual(st.perpState.qty, 0, "perp untouched");
  assert.ok(!st.ledger.some((e) => e.type === "close-options"), "no options close was booked");

  const ok = engine.closeStructure(st, snap, NOON + 130_000); // priced snapshot → clean close
  assert.equal(ok.ok, true);
  assert.equal(st.perpState.qty, 0, "perp flattened on the priced snapshot");
  assert.equal(st.structure, null);
});

test("closeStructure with a FLAT perp closes fine even without a priced perp (nothing to flatten)", () => {
  const { st, snap } = opened(); // no evaluate → no hedge yet, perp qty 0
  assert.equal(st.perpState.qty, 0);
  const degraded = { ...snap, perp: null };
  const r = engine.closeStructure(st, degraded, NOON + 120_000);
  assert.equal(r.ok, true, r.error);
  assert.equal(st.structure, null);
});

// ── engineCfg freeze (audit №10): the position hedges by the ACTUAL open params, not by settings ─
test("engineCfg overlays the ticket's actual params over settings (debounce-race honesty)", () => {
  // settings still say limit (the debounced push hasn't landed), but the ticket opened as market
  const st = engine.create({ nowMs: NOON, settings: { execStyle: "limit", deadbandRefQty: 1 } });
  const snap = mkSnapshot();
  const r = engine.openStructure(st, { ...PARAMS, execStyle: "market", qty: 2 }, mkChain(), snap, NOON);
  assert.equal(r.ok, true, r.error);
  assert.equal(st.structure.engineCfg.execStyle, "market", "frozen exec = the ticket's, not settings'");
  assert.equal(st.structure.engineCfg.qty, 2, "frozen qty echoes the actual open size");

  engine.evaluate(st, snap, NOON); // the paper fill must follow the frozen (actual) style
  const fill = st.ledger.find((e) => e.type === "hedge");
  assert.ok(fill, "hedge executed");
  assert.equal(fill.priceRef, 61001, "market buy crosses to the ask — not the limit-mid fill");
});

// ── А6 R3 (fault-tolerance аудит, ратифицировано 2026-07-20): фандинг-гэп сверх анти-catch-up
// клампа ВИДИМ - копится в perpState.fundingGapSec и оставляет строку funding-gap в леджере.
// Сам кламп (fundingMaxGapSec 300с) не меняется: начислено ровно за клампованное время.
test("R3: ingest через 8ч разрыв - фандинг клампится 300с, пропуск видим (fundingGapSec + строка леджера)", () => {
  const st = engine.create({ nowMs: NOON, settings: { deadbandRefQty: 1 } });
  st.perpState.qty = -12; // короткий хедж 12 контрактов по $10
  st.perpState.avgEntry = 61000;
  st.lastIngestAt = NOON;
  const perp = { funding8h: 0.0001, contractSize: 10, mark: 61000 };

  // штатный тик (15с): гэпа нет - ни поля, ни строки
  engine.ingest(st, { perp, underlying: 61000 }, NOON + 15_000);
  assert.equal(st.perpState.fundingGapSec, 0, "штатный тик не рождает гэп");
  assert.equal(st.ledger.filter((e) => e.type === "funding-gap").length, 0);

  // 8ч разрыв (сон машины): начислено ровно за 300с клампа, остальное видимо пропущено
  const wake = NOON + 15_000 + 8 * 3600_000;
  const before = st.perpState.fundingCum;
  engine.ingest(st, { perp, underlying: 61000 }, wake);
  const clampedDelta = -(-12) * 10 * 0.0001 * (300 / 28800); // −qty·cs·f8h·(dtEff/28800), короткий получает
  near(st.perpState.fundingCum - before, clampedDelta, 1e-12, "начислено ровно за клампованные 300с");
  assert.equal(st.perpState.fundingGapSec, 8 * 3600 - 300, "пропущенное время скопилось в поле");
  const gapRows = st.ledger.filter((e) => e.type === "funding-gap");
  assert.equal(gapRows.length, 1, "одна строка на один разрыв");
  assert.match(gapRows[0].note, /не оценены/);
  assert.equal(gapRows[0].feeUsd, 0, "строка чисто информационная - суммы нулевые");
  assert.equal(gapRows[0].realizedUsd, 0);

  // второй разрыв копится, а не перетирает
  engine.ingest(st, { perp, underlying: 61000 }, wake + 1800_000); // ещё 30 мин
  assert.equal(st.perpState.fundingGapSec, 8 * 3600 - 300 + (1800 - 300), "гэпы аддитивны");
  assert.equal(st.ledger.filter((e) => e.type === "funding-gap").length, 2);
});

// ── Тик без перпа при удерживаемой позиции (fix 2026-08-25) ─────────────────────────────────────
// Живой снимок деградирует так: REST перпа отказал (503), опционные ноги ответили,
// buildDeribitSnapshot отдал perp = null. Прогон mbp15 ронял на этом каждый такой тик:
// attribute() падал в markPerp на perp.contractSize, тик гиб целиком (запись, персист, пуш),
// а lastIngestAt при этом уже уехал вперёд - интервал фандинга терялся молча.
test("тик без перпа: evaluate не падает, решение SKIP, метрики не фолдятся", () => {
  const { st, snap } = opened();
  engine.ingest(st, snap, NOON);
  engine.evaluate(st, snap, NOON); // HEDGE: перп набирается, метрики фолдятся один раз
  assert.ok(st.perpState.qty !== 0, "хедж набран");
  const nBefore = st.metrics.n;

  const degraded = { ...mkSnapshot(1_700_000_015_000), perp: null, liquidity: null };
  const cycle = engine.evaluate(st, degraded, NOON + 15_000); // не должен бросить
  assert.equal(cycle.decision, "SKIP", "деградировавший снимок не торгует");
  assert.equal(cycle.current_futures_delta, 0, "дельту перпа маркировать нечем - честный ноль");
  assert.equal(st.metrics.n, nBefore, "фантомный провал net без MtM перпа в метрики не фолдится");
});

test("тик без перпа не двигает часы фандинга: следующий оценённый тик доначисляет весь разрыв", () => {
  const st = engine.create({ nowMs: NOON, settings: { deadbandRefQty: 1 } });
  st.perpState.qty = -12;
  st.perpState.avgEntry = 61000;
  st.lastIngestAt = NOON;
  const perp = { funding8h: 0.0001, contractSize: 10, mark: 61000 };

  engine.ingest(st, { perp: null, underlying: 61000 }, NOON + 15_000);
  assert.equal(st.lastIngestAt, NOON, "часы не тронуты: начисление не могло пройти");

  const before = st.perpState.fundingCum;
  engine.ingest(st, { perp, underlying: 61000 }, NOON + 30_000);
  const fullDelta = -(-12) * 10 * 0.0001 * (30 / 28800); // весь разрыв 30с, не только последние 15с
  near(st.perpState.fundingCum - before, fullDelta, 1e-12, "доначислен весь интервал от последнего оценённого тика");
  assert.equal(st.lastIngestAt, NOON + 30_000, "оценённый тик двигает часы как обычно");

  // плоская позиция: ждать нечего, часы идут и без перпа
  st.perpState.qty = 0;
  engine.ingest(st, { perp: null, underlying: 61000 }, NOON + 45_000);
  assert.equal(st.lastIngestAt, NOON + 45_000, "без позиции тик без перпа часы двигает");
});

// ── Дельта перпа против его номинала (fix 2026-08-13) ────────────────────────────────────────────
// Ни один прежний тест не держал позицию, у которой средний вход РАЗОШЁЛСЯ с марком, поэтому
// подмена дельты номиналом жила в коде незамеченной. Здесь цена уходит на 10% после перекладки.
test("после движения цены дельта перпа считается от avgEntry, а номинал от марка", () => {
  const { st, snap } = opened();
  engine.ingest(st, snap, NOON);
  engine.evaluate(st, snap, NOON); // ставит хедж: 12 контрактов по 61000
  assert.equal(st.perpState.qty, 12, "хедж исполнен");
  near(st.perpState.avgEntry, 61000, 1e-9, "средний вход равен цене перекладки");

  const up = 67100; // +10%
  const moved = { ...mkSnapshot(NOON + 60_000), underlying: up, index: up,
    perp: { ...mkSnapshot().perp, mark: up, index: up },
    liquidity: { bid: up - 1, ask: up + 1, mid: up, halfSpread: 1 } };
  engine.ingest(st, moved, NOON + 60_000);
  const cyc = engine.evaluate(st, moved, NOON + 60_000);

  near(cyc.current_futures_delta, 120 / 61000, 1e-12, "дельта от avgEntry и по цене НЕ уплыла");
  near(cyc.perp_position.btc, 120 / up, 1e-12, "номинал от текущего марка");
  near(cyc.current_futures_delta / cyc.perp_position.btc, up / 61000, 1e-9, "разошлись в mark/avgEntry");

  // Проверка не повтором формулы, а через P&L: дельта обязана быть производной upl_usd по цене.
  // Позиция между двумя замерами обязана быть ОДНА И ТА ЖЕ, иначе сравнивались бы разные позиции
  // и тест был бы зелёным по случайности. Фикса не было: дельта уже в дедбэнде (см. ниже).
  assert.equal(cyc.decision, "SKIP", "после правки фантомного дрейфа нет и перекладка не нужна");
  const qtyBefore = st.perpState.qty;
  const nudge = { ...moved, underlying: up + 1, index: up + 1,
    perp: { ...moved.perp, mark: up + 1, index: up + 1 } };
  engine.ingest(st, nudge, NOON + 61_000);
  const c2 = engine.evaluate(st, nudge, NOON + 61_000);
  assert.equal(st.perpState.qty, qtyBefore, "позиция не менялась между замерами");
  near(c2.perp_position.upl_usd - cyc.perp_position.upl_usd, cyc.current_futures_delta, 1e-9,
    "P&L на доллар движения спота равен заявленной дельте");
});

// Санитария в юнит-тестах вырождена НАСТРОЙКОЙ, как в прогоне записи: фикстуры, как и запись, не
// несут ни метки тикера, ни книги, и гейт-дефолты наложили бы честное вето (unknown) на первый же
// кандидат. Тесты санитарии живут отдельно и включают оси явно.
const SANITY_OFF = { ageMode: "off", spreadMode: "off", depthMode: "off" };

// ── ИЗМЕРЕННАЯ КОНФИГУРАЦИЯ СХЕМЫ ПРОДАВЦА ЗАМОРАЖИВАЕТСЯ ДВИЖКОМ, А НЕ ЗАДАЁТСЯ СНАРУЖИ
// Пока эти шесть чисел выставлял офлайн-драйвер, сверка книг доказывала свойство скрипта: живой
// профиль по умолчанию даёт полосу 0.1 BTC на контракт вместо 0.03, и это ×24.2 против ×46.5 на
// пятилетней записи при просадке 20.1% против 13.5%.
test("sell-call: движок сам замораживает полосу схемы, а не полосу тулбара", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0); // полдень: вне окна расчёта 08:00 UTC
  const expiry = nowMs + 480 * 3600000; // 480 ч = внутри окна схемы 336-672 ч
  const name = "BTC_USDC-1JAN26-100000-C";
  const chain = [{ instrument_name: name, strike: 100000, expiration_timestamp: expiry,
    option_type: "call", contract_size: 1, min_trade_amount: 0.01, tick_size: 0.5 }];
  const snapshot = {
    underlying: 100000, index: 100000,
    perp: { mark: 100000, index: 100000, contractSize: 10, funding8h: 0.0001, bid: 99999, ask: 100001 },
    legs: { [name]: { instrument: name, type: "call", strike: 100000, expiryMs: expiry,
      bid: 2950, ask: 3050, mark: 3000, markIv: 45, delta: 0.45, vega: 120, theta: -5,
      underlying: 100000, index: 100000, contractSize: 1, minTradeAmount: 0.01, markInUsd: true } },
  };
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
  // профиль СПЕЦИАЛЬНО оставлен дефолтным: полоса «нормальная», λ 1.25, оба триггера и блэкаут
  assert.equal(st.settings.deadbandBtc, 0.001, "профиль по умолчанию не трогали");
  assert.equal(st.settings.settlementBlackout, true);

  const r = engine.openStructure(st, { kind: "sell-call", execStyle: "limit", sanityCfg: SANITY_OFF }, chain, snapshot, nowMs);
  assert.ok(!r.error, `структура не открылась: ${r.error}`);
  const cfg = st.structure.engineCfg;
  assert.equal(cfg.deadbandBtc, 0.03, "полоса схемы, а не тулбара");
  assert.equal(cfg.deadbandRefQty, 1.0, "якорь на контракт");
  assert.equal(cfg.lambda, 0, "фильтр выгоды выключен");
  assert.equal(cfg.settlementBlackout, false, "у схемы нет выходных у хеджа");
  assert.ok(cfg.priceTriggerPct >= 1e9 && cfg.rehedgeSec >= 1e9, "оба триггера недостижимы");
  assert.equal(cfg.execStyle, "limit", "исполнение остаётся за тикетом");
});

test("sell-call: перевход не упирается в собственный блэкаут расчёта 08:00 UTC", () => {
  // Экспирации Deribit наступают РОВНО в 08:00 UTC, то есть в центре окна блэкаута. При живом
  // дефолте preTradeCheck запрещал бы открытие следующей сделки первые десять минут после расчёта.
  const nowMs = Date.UTC(2026, 0, 1, 8, 0, 0); // ровно 08:00 UTC
  const expiry = nowMs + 480 * 3600000;
  const name = "BTC_USDC-1JAN26-100000-C";
  const chain = [{ instrument_name: name, strike: 100000, expiration_timestamp: expiry,
    option_type: "call", contract_size: 1, min_trade_amount: 0.01, tick_size: 0.5 }];
  const snapshot = {
    underlying: 100000, index: 100000,
    perp: { mark: 100000, index: 100000, contractSize: 10, funding8h: 0.0001, bid: 99999, ask: 100001 },
    legs: { [name]: { instrument: name, type: "call", strike: 100000, expiryMs: expiry,
      bid: 2950, ask: 3050, mark: 3000, markIv: 45, delta: 0.45, vega: 120, theta: -5,
      underlying: 100000, index: 100000, contractSize: 1, minTradeAmount: 0.01, markInUsd: true } },
  };
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
  const r = engine.openStructure(st, { kind: "sell-call", execStyle: "limit", sanityCfg: SANITY_OFF }, chain, snapshot, nowMs);
  assert.ok(!r.error, `перевход заблокирован собственным блэкаутом: ${r.error}`);
});

// ── НАКОПИТЕЛЬ ЦЕПОЧКИ. Проверяется то, ради чего он заведён: итог сделки считается РАЗНОСТЬЮ тех
// же четырёх счётчиков, из которых `attribute` складывает net_total, а доходность меряется на
// ЗАЛОГ - в той же базе, в какой опубликован бектест («средняя +4.15% залога»).
function sellFixture(nowMs) {
  const expiry = nowMs + 480 * 3600000;
  const name = "BTC_USDC-1JAN26-100000-C";
  return {
    expiry, name,
    chain: [{ instrument_name: name, strike: 100000, expiration_timestamp: expiry,
      option_type: "call", contract_size: 1, min_trade_amount: 0.01, tick_size: 0.5 }],
    snapshot: {
      underlying: 100000, index: 100000,
      perp: { mark: 100000, index: 100000, contractSize: 10, funding8h: 0, bid: 99999, ask: 100001 },
      legs: { [name]: { instrument: name, type: "call", strike: 100000, expiryMs: expiry,
        bid: 2950, ask: 3050, mark: 3000, markIv: 45, delta: 0.45, vega: 120, theta: -5,
        underlying: 100000, index: 100000, contractSize: 1, minTradeAmount: 0.01, markInUsd: true } },
    },
  };
}

test("цепочка: сделка дописывается в экспирацию и несёт доходность на залог", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = sellFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
  assert.ok(engine.openStructure(st, { kind: "sell-call", execStyle: "limit", sanityCfg: SANITY_OFF }, f.chain, f.snapshot, nowMs).ok);
  assert.equal(st.sellChain.trades.length, 0, "до экспирации строки нет");
  const im = st.structure.sizing.imUsedUsd;

  // Экспирация ВНЕ денег: проданный колл гасится в ноль, продавец оставляет премию минус издержки.
  engine.settleStructure(st, { ...f.snapshot, index: 90000, underlying: 90000 }, f.expiry + 1000);
  assert.equal(st.sellChain.trades.length, 1, "строка появилась ровно одна");
  const t = st.sellChain.trades[0];
  assert.equal(t.reason, "expiry", "штатный выход");
  assert.equal(t.instrument, f.name);
  near(t.imUsd, im, 1e-9, "залог тот же, что показала структура");
  near(t.retImPct, (t.pnlUsd / im) * 100, 1e-9, "доходность считается на ЗАЛОГ");
  assert.ok(t.pnlUsd > 0, `колл истёк пустым, продавец в плюсе: ${t.pnlUsd}`);

  const s = engine.sellChainStats(st);
  assert.equal(s.n, 1);
  assert.equal(s.wins, 1);
  near(s.equityMult, 1 + t.retImPct / 100, 1e-12, "мультипликатор перемножает (1 + доходность залога)");
  near(s.medianHoldD, 20, 0.01, "480 ч = 20 суток");
});

test("цепочка: досрочное закрытие помечается навсегда", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = sellFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
  engine.openStructure(st, { kind: "sell-call", execStyle: "limit", sanityCfg: SANITY_OFF }, f.chain, f.snapshot, nowMs);
  engine.closeStructure(st, f.snapshot, nowMs + 3600000);
  assert.equal(st.sellChain.trades[0].reason, "manual", "выход вне схемы");
  assert.equal(engine.sellChainStats(st).manual, 1, "сводка считает досрочные отдельно");
});

test("цепочка: поправка delivery-сверки доезжает до своей сделки и не задевает следующую", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = sellFixture(nowMs);
  // Гонка из аудита: цепочка переоткрывается через ~30 секунд, а поправка delivery приходит
  // минутами позже, когда замер СЛЕДУЮЩЕЙ сделки уже снят. Контрольный прогон без поправки
  // доказывает, что окно следующей сделки её не несёт.
  const run = (withAdjust) => {
    const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
    assert.ok(engine.openStructure(st, { kind: "sell-call", execStyle: "limit", sanityCfg: SANITY_OFF }, f.chain, f.snapshot, nowMs).ok);
    engine.settleStructure(st, { ...f.snapshot, index: 90000, underlying: 90000 }, f.expiry + 1000);
    const settleSeq = st.ledger.findLast((r) => r.type === "settle-options").seq;
    const now2 = f.expiry + 60000;
    const f2 = sellFixture(now2);
    assert.ok(engine.openStructure(st, { kind: "sell-call", execStyle: "limit", sanityCfg: SANITY_OFF }, f2.chain, f2.snapshot, now2).ok);
    if (withAdjust) {
      st.realizedOptionsUsd += 50; // так книжит вызывающий (maybeReconcileSettles)
      assert.equal(engine.chainApplySettleAdjust(st, settleSeq, 50), true);
    }
    engine.settleStructure(st, { ...f2.snapshot, index: 90000, underlying: 90000 }, f2.expiry + 1000);
    return st;
  };
  const a = run(true), b = run(false);
  const t1 = a.sellChain.trades[0], t1b = b.sellChain.trades[0];
  assert.equal(t1b.preliminary, true, "до поправки итог помечен предварительным");
  near(t1.pnlUsd, t1b.pnlUsd + 50, 1e-9, "поправка легла в свою сделку");
  near(t1.retImPct, (t1.pnlUsd / t1.imUsd) * 100, 1e-9, "доходность пересчитана на залог");
  assert.equal(t1.preliminary, false, "пометка предварительного итога снята");
  near(t1.adjustUsd, 50, 1e-12, "величина поправки сохранена в строке");
  near(a.sellChain.trades[1].pnlUsd, b.sellChain.trades[1].pnlUsd, 1e-9, "окно следующей сделки чужую поправку не несёт");

  // Поправка без адресата (строки, записанные до появления settleSeq) цепочку не трогает и не роняет.
  const c = run(false);
  const before = c.sellChain.trades.map((t) => t.pnlUsd);
  assert.equal(engine.chainApplySettleAdjust(c, 999999, 10), false);
  assert.deepEqual(c.sellChain.trades.map((t) => t.pnlUsd), before);
});

test("цепочка: покрытие опроса меряется за жизнь ОДНОЙ сделки", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = sellFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000, repriceSec: 15 } });
  engine.openStructure(st, { kind: "sell-call", execStyle: "limit", sanityCfg: SANITY_OFF }, f.chain, f.snapshot, nowMs);
  for (let k = 1; k <= 4; k++) engine.ingest(st, f.snapshot, nowMs + k * 15000);
  engine.ingest(st, f.snapshot, nowMs + 4 * 15000 + 3600000); // час без опроса
  const u = engine.uptimeStats(st);
  assert.equal(u.ticks, 5, "пять решений");
  assert.equal(u.gaps.length, 1, "перерыв зафиксирован ровно один");
  assert.ok(u.maxGapMs >= 3600000, "длина перерыва не потеряна");
  // Слоты считаются ВКЛЮЧИТЕЛЬНО по обоим концам: без этого на коротких окнах выходят проценты выше ста.
  assert.ok(u.coveragePct < 5, `покрытие честно низкое: ${u.coveragePct}`);
  assert.ok(u.effectiveSec > 900, `эффективный каданс отражает простой: ${u.effectiveSec}`);
});

test("ensureSellChain: поднимает накопитель у старого персиста и не трогает живой", () => {
  // Профиль июльской сборки: состояния цепочки нет вовсе (найдено развёртыванием на mbp15).
  const st = engine.create({ nowMs: 0 });
  delete st.sellChain;
  const ch = engine.ensureSellChain(st);
  assert.equal(ch.on, false);
  assert.equal(ch.mode, "continuous");
  assert.deepEqual(ch.trades, []);
  ch.on = true;
  ch.trades.push({ x: 1 });
  assert.equal(engine.ensureSellChain(st), ch, "повторный вызов отдаёт тот же объект");
  assert.equal(st.sellChain.on, true, "живое состояние не перезатирается");
});

// ── ПРИЧИНЫ ПЕРЕРЫВОВ ОПРОСА: чистый классификатор по хинтам вызывающего, словарь закрыт.
test("classifyGapCause: сон точнее бута, бут точнее источника, без хинтов честный unknown", () => {
  const gap = { fromMs: 1000_000, toMs: 2000_000 };
  assert.equal(engine.classifyGapCause({ ...gap, hints: { sleepWindow: { start: 1200_000, end: 1800_000 } } }), "sleep");
  assert.equal(engine.classifyGapCause({ ...gap, hints: { sleepWindow: { start: 1500_000, end: 2500_000 }, bootAt: 1600_000 } }),
    "sleep", "окно сна пересекает перерыв - сон побеждает бут");
  assert.equal(engine.classifyGapCause({ ...gap, hints: { bootAt: 1500_000 } }), "app-down");
  assert.equal(engine.classifyGapCause({ ...gap, hints: { bootAt: 999_000 } }), "unknown", "бут до перерыва не объясняет его");
  assert.equal(engine.classifyGapCause({ ...gap, hints: { sourceErrorSince: 1100_000 } }), "no-response");
  assert.equal(engine.classifyGapCause({ ...gap, hints: {} }), "unknown");
  assert.equal(engine.classifyGapCause({ ...gap, hints: { sleepWindow: { start: 2100_000, end: 2500_000 } } }),
    "unknown", "сон после перерыва его не объясняет");
});

test("ingest: перерыв опроса несёт причину из хинтов", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = sellFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000, repriceSec: 15 } });
  engine.openStructure(st, { kind: "sell-call", execStyle: "limit", sanityCfg: SANITY_OFF }, f.chain, f.snapshot, nowMs);
  engine.ingest(st, f.snapshot, nowMs);
  const later = nowMs + 3600000; // час без опроса
  engine.ingest(st, f.snapshot, later, { sleepWindow: { start: nowMs + 60000, end: later - 60000 } });
  const u = engine.uptimeStats(st);
  assert.equal(u.gaps.length, 1);
  assert.equal(u.gaps[0].cause, "sleep");
});

// ── САНИТАРИЯ В ЖИВОМ ОТКРЫТИИ (§1.8): вето переключает контракт, полный отказ заводит окно
// ожидания, после окна открывается лучшая по дельте с постоянной пометкой «ухудшенная санитария».
function sanityFixture(nowMs) {
  const expiry = nowMs + 480 * 3600000;
  const A = "BTC_USDC-T-100000-C", B = "BTC_USDC-T-104000-C";
  const meta = (name, strike) => ({ instrument_name: name, strike, expiration_timestamp: expiry,
    option_type: "call", contract_size: 1, min_trade_amount: 0.01, tick_size: 0.5 });
  const mkLeg = (name, strike, delta, over = {}) => [name, { instrument: name, type: "call", strike,
    expiryMs: expiry, bid: 2950, ask: 3050, mark: 3000, markIv: 45, delta, vega: 120, theta: -5,
    underlying: 100000, index: 100000, contractSize: 1, minTradeAmount: 0.01, markInUsd: true,
    ts: nowMs - 5000, book: { bidDepthUsd: 20000, askDepthUsd: 20000 }, ...over }];
  return {
    expiry, A, B,
    chain: [meta(A, 100000), meta(B, 104000)],
    snapshot: {
      underlying: 100000, index: 100000,
      perp: { mark: 100000, index: 100000, contractSize: 10, funding8h: 0, bid: 99999, ask: 100001 },
      legs: Object.fromEntries([
        mkLeg(A, 100000, 0.47, { bid: 2400, ask: 3600 }), // ближе к цели, но спред 40% премии
        mkLeg(B, 104000, 0.40), // дальше от цели, зато торгуема
      ]),
    },
  };
}

test("санитария: вето переключает ногу на следующую в допуске, а не блокирует открытие", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = sanityFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
  const r = engine.openStructure(st, { kind: "sell-call", execStyle: "limit" }, f.chain, f.snapshot, nowMs);
  assert.ok(r.ok, `не открылась: ${r.error}`);
  assert.equal(st.structure.legs[0].instrument, f.B, "выбрана вторая по дельте, первую завалил спред");
  assert.equal(st.structure.sanity, "ok");
  assert.equal(st.structure.sanityChecks.length, 2, "проверены обе: A с вето, B с pass");
  assert.equal(st.sellChain.sanityWaitingSince, null);
});

test("санитария: полный отказ заводит окно ожидания, после окна открытие с постоянной пометкой", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = sanityFixture(nowMs);
  f.snapshot.legs[f.B].bid = 2400; f.snapshot.legs[f.B].ask = 3600; // теперь спред валит обе
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
  const open = (t) => engine.openStructure(st, { kind: "sell-call", execStyle: "limit" }, f.chain, f.snapshot, t);

  const r = open(nowMs);
  assert.equal(r.code, "sanity-none-passed");
  assert.match(r.error, /Санитария: ни одна из 2/);
  assert.match(r.error, /спред/);
  assert.equal(st.sellChain.sanityWaitingSince, nowMs, "окно ожидания завелось");

  const r2 = open(nowMs + 3600000); // внутри окна 4 ч
  assert.equal(r2.code, "sanity-none-passed");
  assert.equal(st.sellChain.sanityWaitingSince, nowMs, "начало ожидания не сдвигается повторами");

  const late = nowMs + 4 * 3600000; // окно истекло ровно
  const r3 = open(late);
  assert.ok(r3.ok, `после окна обязана открыться: ${r3.error}`);
  assert.equal(st.structure.sanity, "degraded", "пометка на структуре");
  assert.equal(st.structure.legs[0].instrument, f.A, "лучшая по дельте, невзирая на санитарию");
  assert.equal(st.sellChain.sanityWaitingSince, null, "успех сбрасывает окно");

  engine.settleStructure(st, { ...f.snapshot, index: 90000, underlying: 90000 }, f.expiry + 1000);
  assert.equal(st.sellChain.trades[0].sanity, "degraded", "пометка доезжает до сделки цепочки");
});

// ── Маржин-алерт (ревизия 2026-08-25 Р1): строки margin-alert на пересечении порогов ВВЕРХ,
// гистерезис 5 п.п., account() несёт запас в долларах и оценку цены ликвидации.

const maRows = (st) => st.ledger.filter((e) => e.type === "margin-alert");
const maTick = (st, mu, t) =>
  engine.trackMarginAlert(st, { maintenance_utilisation: mu, equity: 1000, maintenance_margin: 1000 * mu }, { index: 60000 }, { marginAlertPct: 0.8 }, t);

test("margin-alert: пересечение 80% вверх даёт одну строку, дрожание над порогом не повторяет её", () => {
  const st = engine.create({ nowMs: NOON });
  maTick(st, 0.5, 1000);
  assert.equal(maRows(st).length, 0, "ниже порога строк нет");
  maTick(st, 0.82, 2000);
  assert.equal(maRows(st).length, 1, "пересечение 80% вверх");
  assert.equal(maRows(st)[0].meta.level, 1);
  near(maRows(st)[0].meta.threshold, 0.8, 1e-12, "порог в meta");
  assert.equal(maRows(st)[0].priceRef, 60000, "цена индекса в строке");
  maTick(st, 0.83, 3000);
  maTick(st, 0.81, 4000);
  assert.equal(maRows(st).length, 1, "выше порога повторных строк нет");
});

test("margin-alert: гистерезис 5 п.п. - спад до 76% не взводит, ниже 75% взводит заново", () => {
  const st = engine.create({ nowMs: NOON });
  maTick(st, 0.82, 1000);
  maTick(st, 0.76, 2000); // внутри гистерезиса: уровень держится
  maTick(st, 0.82, 3000);
  assert.equal(maRows(st).length, 1, "внутри гистерезиса повторного алерта нет");
  maTick(st, 0.74, 4000); // ниже порог − 0.05: уровень снят
  maTick(st, 0.82, 5000);
  assert.equal(maRows(st).length, 2, "после спада ниже 75% новое пересечение алармит");
});

test("margin-alert: скачок сразу за 90% даёт одну строку уровня 2; спад и возврат алармит уровнем 2", () => {
  const st = engine.create({ nowMs: NOON });
  maTick(st, 0.95, 1000);
  assert.equal(maRows(st).length, 1, "один тик через оба порога = одна строка");
  assert.equal(maRows(st)[0].meta.level, 2);
  near(maRows(st)[0].meta.threshold, 0.9, 1e-12, "верхний порог");
  assert.match(maRows(st)[0].note, /зона ликвидации/);
  maTick(st, 0.86, 2000); // выше 0.85: уровень 2 держится
  maTick(st, 0.93, 3000);
  assert.equal(maRows(st).length, 1);
  maTick(st, 0.84, 4000); // ниже 0.85: уровень спал до 1
  maTick(st, 0.91, 5000); // новое пересечение 90%
  assert.equal(maRows(st).length, 2);
  assert.equal(maRows(st)[1].meta.level, 2);
});

test("margin-alert: профиль без поля marginAlert (старый персист) поднимается на лету", () => {
  const st = engine.create({ nowMs: NOON });
  delete st.marginAlert;
  maTick(st, 0.82, 1000);
  assert.equal(maRows(st).length, 1, "лениво поднятое поле работает");
  assert.equal(st.marginAlert.level, 1);
});

test("account(): mm_headroom_usd и liq_price_est едут в счёт; конвейер evaluate пишет строку margin-alert", () => {
  const { st, snap } = opened(); // депозит $100, MM стрэддла ≈ $8.8k ⇒ утилизация >> 100%
  const cyc = engine.evaluate(st, snap, NOON + 60000);
  const a = cyc.account;
  assert.ok(a.maintenance_utilisation > 1, "фикстура заведомо в зоне");
  near(a.mm_headroom_usd, a.equity - a.maintenance_margin, 1e-9, "запас = equity − MM");
  assert.equal(a.liq_price_est, 61000, "уже в зоне: оценка ликвидации = текущий индекс");
  const rows = maRows(st);
  assert.equal(rows.length, 1, "evaluate оставил ровно одну строку margin-alert");
  assert.equal(rows[0].meta.level, 2);
  assert.equal(cyc.account.margin_alert_level, 2, "счёт несёт ступень ЭТОГО тика (уточнена после трекера)");
  const again = engine.evaluate(st, snap, NOON + 120000);
  assert.equal(maRows(st).length, 1, "второй тик выше порога строку не дублирует");
  assert.ok(again.account.margin_alert, "флаг алерта карточки живёт как жил");
  assert.equal(again.account.margin_alert_level, 2, "ступень держится гистерезисом");
});

test("account(): без структуры liq_price_est = null, запас равен всему счёту, ступень 0", () => {
  const st = engine.create({ nowMs: NOON, settings: { paperEquityUsd: 100 } });
  const a = engine.account(st, mkSnapshot());
  assert.equal(a.liq_price_est, null);
  near(a.mm_headroom_usd, a.equity, 1e-9, "MM нулевая - запас равен equity");
  assert.equal(a.margin_alert_level, 0, "плоский счёт - ступень алерта нулевая");
  near(a.margin_alert_pct, 0.8, 1e-12, "порог алерта отдаётся явно (дефолт)");
  const st2 = engine.create({ nowMs: NOON, settings: { marginAlertPct: 0.7 } });
  near(engine.account(st2, mkSnapshot()).margin_alert_pct, 0.7, 1e-12, "настройка двигает порог в счёте");
});

test("entryIndex: открытие штампует индекс входа, цикл несёт entry_index, старый персист живёт fallback-ом", () => {
  const { st, snap } = opened();
  assert.equal(st.structure.entryIndex, 61000, "индекс снимка на моменте открытия");
  const cyc = engine.evaluate(st, snap, NOON + 60000);
  assert.equal(cyc.entry_index, 61000);
  delete st.structure.entryIndex; // структура, записанная до появления поля
  const cyc2 = engine.evaluate(st, snap, NOON + 120000);
  assert.equal(cyc2.entry_index, st.structure.entryUnderlying, "fallback на entryUnderlying");
  engine.closeStructure(st, snap, NOON + 180000);
  const cyc3 = engine.evaluate(st, snap, NOON + 240000);
  assert.equal(cyc3.entry_index, null, "без структуры якоря нет");
});

// ── СТРЭНГЛ ПРОДАВЦА (kind sell-strangle): правила пары - sellstrangle.js, исполнитель тот же ────
// Проверяется главное обещание переноса: отдельного исполнителя у пары НЕТ. Открытие идёт общей
// веткой продавца, хедж решает НЕТТО-дельта через optionDeltaTotal, маржа - сумма ног тем же
// legMargin, расчёт в экспирацию - общий settleStructure по списку ног, цепочка - те же счётчики.

function strangleFixture(nowMs) {
  const expiry = nowMs + 480 * 3600000; // 480 ч = внутри окна схемы 336-672 ч
  const callName = "BTC_USDC-1JAN26-100000-C";
  const putName = "BTC_USDC-1JAN26-90000-P";
  const meta = (n, k, t) => ({ instrument_name: n, strike: k, expiration_timestamp: expiry,
    option_type: t, contract_size: 1, min_trade_amount: 0.01, tick_size: 0.5 });
  const leg = (n, k, t, mark, delta) => ({ instrument: n, type: t, strike: k, expiryMs: expiry,
    bid: mark - 50, ask: mark + 50, mark, markIv: 45, delta, gamma: 0.00001, vega: 120, theta: -5,
    underlying: 100000, index: 100000, contractSize: 1, minTradeAmount: 0.01, markInUsd: true });
  return {
    expiry, callName, putName,
    chain: [meta(callName, 100000, "call"), meta(putName, 90000, "put")],
    snapshot: {
      underlying: 100000, index: 100000,
      perp: { mark: 100000, index: 100000, contractSize: 10, funding8h: 0, bid: 99999, ask: 100001 },
      legs: {
        [callName]: leg(callName, 100000, "call", 3000, 0.45),
        [putName]: leg(putName, 90000, "put", 2600, -0.45),
      },
    },
  };
}
const strangleIm = (f) =>
  legMargin({ type: "call", side: "short", strike: 100000, mark: 3000, underlying: 100000, index: 100000, amount: 1 }).im
  + legMargin({ type: "put", side: "short", strike: 90000, mark: 2600, underlying: 100000, index: 100000, amount: 1 }).im;

test("стрэнгл: открывается парой коротких ног, залог суммой, размер от залога пары", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = strangleFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
  const r = engine.openStructure(st, { kind: "sell-strangle", execStyle: "limit", sanityCfg: SANITY_OFF }, f.chain, f.snapshot, nowMs);
  assert.ok(r.ok, `открытие: ${r.error ?? "ok"}`);
  const b = st.structure;
  assert.equal(b.kind, "sell-strangle");
  assert.deepEqual(b.legs.map((l) => [l.type, l.side]), [["call", "short"], ["put", "short"]], "порядок [колл, пут]");
  const imPair = strangleIm(f);
  near(b.sizing.imPerContract, imPair, 1e-9, "залог за контракт пары = сумма ног тем же legMargin");
  assert.equal(b.sizing.lots, Math.floor((200000 * 0.70) / (imPair * 0.01)), "лоты от залога пары, вниз");
  assert.equal(b.legs[0].qtyAbs, b.legs[1].qtyAbs, "закон равных ног");
  assert.ok(b.id.includes("100000x90000"), `id несёт пару страйков: ${b.id}`);
  near(b.entryDebitUsd, -(3000 + 2600) * b.legs[0].qtyAbs, 1e-9, "кредит премий двух ног");
  assert.equal(b.strikes.atm, undefined, "середины у стрэнгла нет - тент не рисуется");
  assert.equal(b.pickedLeg.name, f.callName, "зона продавца судит по колловой ноге");
  const open = st.ledger.find((row) => row.type === "open");
  assert.ok(open.note.includes("продажа стрэнгла") && open.note.includes("+"), open.note);
  const cost = st.ledger.find((row) => row.type === "open-cost");
  assert.ok(cost && cost.realizedUsd < 0, "издержки входа книжатся сразу и отрицательны");
});

test("стрэнгл: хедж решает НЕТТО-дельта пары - симметрия стоит, перекос перекладывает", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = strangleFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
  assert.ok(engine.openStructure(st, { kind: "sell-strangle", execStyle: "limit", sanityCfg: SANITY_OFF }, f.chain, f.snapshot, nowMs).ok);
  const q = st.structure.legs[0].qtyAbs;
  engine.ingest(st, f.snapshot, nowMs);
  assert.equal(st.sellChain.uptime.ticks, 1, "непрерывность опроса считается и для пары");
  const c1 = engine.evaluate(st, f.snapshot, nowMs);
  near(c1.net_option_delta_bs, 0, 1e-12, "дельты ног взаимно гасятся на входе");
  assert.equal(st.perpState.qty, 0, "нетто-нуль не хеджируется - как у эталона пары");
  // Колл ушёл в деньги: нетто-дельта пары -0.15·q, полоса 0.03·q - разрыв в пять полос.
  const moved = { ...f.snapshot, legs: { ...f.snapshot.legs,
    [f.callName]: { ...f.snapshot.legs[f.callName], delta: 0.60 } } };
  const t2 = nowMs + 60000;
  engine.ingest(st, moved, t2);
  const c2 = engine.evaluate(st, moved, t2);
  near(c2.target_futures_delta, 0.15 * q, 1e-9, "цель = минус нетто-дельта опционов");
  near(c2.hedge_deadband_btc, 0.03 * q, 1e-12, "полоса схемы масштабируется размером пары");
  assert.equal(c2.decision, "HEDGE", "разрыв за полосой перекладывает");
  assert.ok(st.perpState.qty > 0, "куплен перп под коротким коллом в деньгах");
});

test("стрэнгл: экспирация гасит обе ноги общим расчётом и дописывает сделку цепочки", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = strangleFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
  assert.ok(engine.openStructure(st, { kind: "sell-strangle", execStyle: "limit", sanityCfg: SANITY_OFF }, f.chain, f.snapshot, nowMs).ok);
  const q = st.structure.legs[0].qtyAbs;
  const entryCost = -st.ledger.find((row) => row.type === "open-cost").realizedUsd;
  // Индекс 85000: колл пуст, пут в деньгах на 5000. Премии 5600 покрывают выкуп - продавец в плюсе.
  engine.settleStructure(st, { ...f.snapshot, index: 85000, underlying: 85000 }, f.expiry + 1000);
  const settleRow = st.ledger.findLast((row) => row.type === "settle-options");
  near(settleRow.realizedUsd, (5600 - 5000) * q, 1e-6, "расчёт = кредит премий минус внутренняя пута");
  assert.equal(settleRow.meta.legs.length, 2, "delivery-сверка получает геометрию ОБЕИХ ног");
  assert.equal(st.sellChain.trades.length, 1, "строка цепочки одна");
  const t = st.sellChain.trades[0];
  assert.equal(t.instrument, `${f.callName}+${f.putName}`, "сделка называет обе ноги");
  near(t.pnlUsd, (5600 - 5000) * q - entryCost, 1e-6, "итог = расчёт минус издержки входа");
  near(t.retImPct, (t.pnlUsd / t.imUsd) * 100, 1e-9, "доходность на залог пары");
  assert.equal(engine.sellChainStats(st).n, 1, "сводка цепочки видит сделку пары");
});

// ── АВТОНОМНЫЙ РАЗМЕР (стресс-правило) и ФОЛБЭК ПАРЫ ────────────────────────────────────────────
import { lotsByStressMargin } from "../src/engine/btcopt/margin.js";

test("размер: стресс-правило считает лоты само из живых величин ноги (sizeRule stress)", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = sellFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
  const r = engine.openStructure(st, { kind: "sell-call", execStyle: "limit", sanityCfg: SANITY_OFF,
    sellCfg: { sizeRule: "stress" } }, f.chain, f.snapshot, nowMs);
  assert.ok(r.ok, r.error);
  const sz = st.structure.sizing;
  assert.equal(sz.rule, "stress", "правило помечено на структуре");
  const want = lotsByStressMargin({ legs: [{ type: "call", strike: 100000, mark: 3000 }],
    indexUsd: 100000, equityUsd: 200000, xPct: 45, capFrac: 0.8, lot: 0.01 });
  assert.equal(sz.lots, want.lots, "лоты равны движковому правилу при константах схемы (45/0.8)");
  assert.equal(sz.stress.bindingSide, "up", "колл связывает верхняя сторона");
  // Вручную: I+ = 145000, внутренняя 45000 + tv 3000 → марк 48000; MM = 0.075·145000 + 48000 = 58875.
  near(sz.stress.mm1Up, 58875, 1e-6, "модель марка «внутренняя на стрессе плюс текущая временная»");
  assert.equal(want.lots, Math.floor((200000 * 0.8) / (58875 * 0.01)), "деление по связывающей стороне");
});

test("размер: стрэнгл при стресс-правиле держит ОБЕ стороны и строже колла", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = strangleFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
  const r = engine.openStructure(st, { kind: "sell-strangle", execStyle: "limit", sanityCfg: SANITY_OFF,
    sellCfg: { sizeRule: "stress" } }, f.chain, f.snapshot, nowMs);
  assert.ok(r.ok, r.error);
  const sz = st.structure.sizing;
  assert.equal(sz.rule, "stress");
  assert.ok(Number.isFinite(sz.stress.mm1Up) && Number.isFinite(sz.stress.mm1Down), "обе стороны посчитаны");
  const callOnly = lotsByStressMargin({ legs: [{ type: "call", strike: 100000, mark: 3000 }],
    indexUsd: 100000, equityUsd: 200000, xPct: 45, capFrac: 0.8, lot: 0.01 });
  assert.ok(sz.lots < callOnly.lots, "пара строже одиночного колла: обе ноги в каждой стороне");
});

test("размер: стресс-правило на нехватке счёта отказывает СВОИМ текстом с числами", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = sellFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 100 } });
  const r = engine.openStructure(st, { kind: "sell-call", execStyle: "limit", sanityCfg: SANITY_OFF,
    sellCfg: { sizeRule: "stress" } }, f.chain, f.snapshot, nowMs);
  assert.ok(r.error && /Стресс-правило не даёт ни лота/.test(r.error), r.error);
  assert.ok(/±45%/.test(r.error) && /80%/.test(r.error), "отказ называет константы схемы");
  // Сверка руководства 2026-08-27: жетон СТОП судит по коду, а не по разбору русского текста -
  // текст стресс-ветки не попадал под /залог|депозит/ детектора карточки, и живая цепочка
  // (sizeRule stress) на нехватке счёта вечно показывала ПОДБОР.
  assert.equal(r.code, "no-lots", "отказ размера несёт структурированный код для жетона СТОП");
});

test("размер: отказ deploy-правила несёт ТОТ ЖЕ код no-lots, что и стресс", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = sellFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 100 } });
  // sellCfg не передан: правило размера - движковый дефолт (deploy), ветка «Залог не помещается».
  const r = engine.openStructure(st, { kind: "sell-call", execStyle: "limit", sanityCfg: SANITY_OFF },
    f.chain, f.snapshot, nowMs);
  assert.ok(r.error && /не помещается в счёт/.test(r.error), r.error);
  assert.equal(r.code, "no-lots", "код един на обе ветки правила размера");
});

test("размер: отказ пары при стресс-правиле доносит код no-lots через строитель стрэнгла", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = strangleFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 100 } });
  const r = engine.openStructure(st, { kind: "sell-strangle", execStyle: "limit", sanityCfg: SANITY_OFF,
    sellCfg: { sizeRule: "stress" } }, f.chain, f.snapshot, nowMs);
  assert.ok(r.error && /Стресс-правило не даёт ни лота/.test(r.error), r.error);
  // Код no-lots НЕ путается с no-leg: фолбэк пары на колл срабатывает только на структурном
  // отсутствии пары, нехватка счёта фолбэком не лечится - колл не поместился бы так же.
  assert.equal(r.code, "no-lots", "строитель пары пробрасывает код правила размера");
});

test("фолбэк пары: нет пары структурно (no-leg) - цепочка стрэнгла открывает КОЛЛ и честно метит kind", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = sellFixture(nowMs); // в фикстуре ЕСТЬ колл и НЕТ пута
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
  const r = engine.openStructure(st, { kind: "sell-strangle", execStyle: "limit", sanityCfg: SANITY_OFF }, f.chain, f.snapshot, nowMs);
  assert.ok(r.ok, r.error);
  assert.equal(st.structure.kind, "sell-call", "структура несёт то, что реально продано");
  assert.equal(st.structure.legs.length, 1);
  assert.ok(st.ledger.find((row) => row.type === "open").note.includes("продажа колла"), "леджер называет колл");
});

// ── ДОСРОЧНЫЙ ВЫХОД ПО ПРАВИЛУ (предрегистрация 2026-08-28).
// Главное, что проверяется: правило по умолчанию ВЫКЛЮЧЕНО, его состояние переживает сериализацию
// состояния, а сработавший выход платит вторую половину круга и помечает сделку своей причиной.
const STOP_MNY = { metric: "mny", level: 0.03, action: "exit", hyst: "oneshot", fill: "same" };
const sellWithStop = (nowMs, stop) => {
  const f = sellFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
  const r = engine.openStructure(st,
    { kind: "sell-call", execStyle: "limit", sanityCfg: SANITY_OFF, ...(stop ? { sellCfg: { stop } } : {}) },
    f.chain, f.snapshot, nowMs);
  assert.ok(r.ok, `структура обязана открыться: ${r.error ?? ""}`);
  return { f, st };
};
// Спот ушёл за страйк на 4%: предикат mny с порогом 0.03 обязан сработать.
const breachSnap = (f) => ({
  ...f.snapshot, underlying: 104000, index: 104000,
  perp: { ...f.snapshot.perp, mark: 104000, index: 104000 },
  legs: { [f.name]: { ...f.snapshot.legs[f.name], bid: 4950, ask: 5050, mark: 5000, delta: 0.92 } },
});

test("стоп: по умолчанию правила нет и evaluate ничего не закрывает", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const { f, st } = sellWithStop(nowMs, null);
  assert.equal(st.structure.engineCfg.stop, null, "боевой дефолт - выхода нет");
  engine.evaluate(st, breachSnap(f), nowMs + 3600000);
  assert.ok(st.structure, "без правила структура обязана остаться открытой");
});

test("стоп: правило замораживается на структуре при открытии", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const { st } = sellWithStop(nowMs, STOP_MNY);
  assert.deepEqual(st.structure.engineCfg.stop, STOP_MNY, "позиция судится правилом, под которым открыта");
  st.settings.stop = null; // оператор передумал уже после открытия
  assert.deepEqual(st.structure.engineCfg.stop, STOP_MNY, "живая настройка не переписывает правило работающей сделки");
});

test("стоп: сработавшее правило закрывает сделку, платит выход и метит причину", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const { f, st } = sellWithStop(nowMs, STOP_MNY);
  const expiryMs = st.structure.expiryMs;
  engine.evaluate(st, breachSnap(f), nowMs + 3600000);

  assert.equal(st.structure, null, "структура закрыта правилом");
  const types = st.ledger.map((r) => r.type);
  assert.ok(types.includes("close-options"), "выкуп опциона записан");
  assert.ok(types.includes("close-cost"), "вторая половина круга записана: досрочный выход пересекает книгу");
  const cost = st.ledger.find((r) => r.type === "close-cost");
  assert.ok(cost.realizedUsd < 0, "издержки выхода списываются, а не начисляются");
  const t = st.sellChain.trades.at(-1);
  assert.equal(t.reason, "stop", "причина закрытия названа своим именем, а не «manual»");
  assert.equal(t.preliminary, false, "выкуп не ждёт delivery-цены: она нужна только расчёту в экспирацию");
  assert.equal(st.sellChain.reopenAfterMs, expiryMs, "цепочка ждёт ИСХОДНУЮ экспирацию остановленной сделки");
});

test("стоп: издержки выхода попадают в СВОЮ сделку, а не в следующую", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const { f, st } = sellWithStop(nowMs, STOP_MNY);
  engine.evaluate(st, breachSnap(f), nowMs + 3600000);
  const cost = st.ledger.find((r) => r.type === "close-cost");
  const closeSeq = st.ledger.find((r) => r.type === "close-options").seq;
  assert.ok(cost.seq > closeSeq, "строка издержек идёт после выкупа");
  // Итог сделки цепочки обязан УЖЕ включать издержки выхода: они списаны до chainAppendTrade.
  const t = st.sellChain.trades.at(-1);
  const optRows = st.ledger.filter((r) => Number.isFinite(r.realizedUsd));
  const sum = optRows.reduce((a, r) => a + r.realizedUsd, 0);
  assert.ok(t.pnlUsd <= sum + 1e-6, `итог сделки не больше суммы книжных строк: ${t.pnlUsd} против ${sum}`);
});

test("стоп: состояние затвора переживает сериализацию состояния", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  // band требует ДВУХ шагов подряд за порогом: первый тик обязан только взвести счётчик.
  const { f, st } = sellWithStop(nowMs, { ...STOP_MNY, hyst: "band" });
  engine.evaluate(st, breachSnap(f), nowMs + 3600000);
  assert.ok(st.structure, "одного шага за порогом мало");
  assert.equal(st.structure.stopGate.run, 1, "счётчик подряд идущих взведён");

  // Перезапуск приложения: состояние уходит в файл и поднимается обратно.
  const revived = JSON.parse(JSON.stringify(st));
  assert.equal(revived.structure.stopGate.run, 1, "счётчик пережил запись в файл");
  engine.evaluate(revived, breachSnap(f), nowMs + 7200000);
  assert.equal(revived.structure, null, "второй шаг подряд закрывает сделку и после рестарта");
});

test("стоп: действия halve и restore живой бот не принимает молча", () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const f = sellFixture(nowMs);
  const st = engine.create({ nowMs, settings: { paperEquityUsd: 200000 } });
  const r = engine.openStructure(st,
    { kind: "sell-call", execStyle: "limit", sanityCfg: SANITY_OFF, sellCfg: { stop: { ...STOP_MNY, action: "halve" } } },
    f.chain, f.snapshot, nowMs);
  assert.ok(r.error && /не реализовано/.test(r.error), `ожидался внятный отказ, получено: ${JSON.stringify(r)}`);
  assert.equal(st.structure, null, "структура не открыта");
});
