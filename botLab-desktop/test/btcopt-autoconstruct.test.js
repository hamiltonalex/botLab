// btcopt-autoconstruct.test.js — Phase 3a auto-construct golden numbers for «BTC-опционы»
// (src/engine/btcopt/structure.js): pickExpiry (nearest live expiry ≤ maxDays), auto ATM/wings strike
// resolution via pickExpiry → buildStructure, and the structured pre-trade rejections
// (structureRejections + the validateStructure thin wrapper). Pure & deterministic; the chain/snapshot
// fixtures are crafted INLINE (no fixtures files, no network, no Date.now).
import test from "node:test";
import assert from "node:assert/strict";
import { pickExpiry, buildStructure, structureRejections, validateStructure } from "../src/engine/btcopt/structure.js";

const near = (a, b, tol, l) => assert.ok(Math.abs(a - b) < tol, `${l}: got ${a} want ${b}`);

// "now" is 2026-07-10 12:00 UTC; Deribit expiries settle 08:00 UTC. E1/E2/E3 are inside the default
// 3-day window (+20h/+44h/+68h), E_FAR (+116h) is beyond it, E_PAST (−4h) is dead.
const NOW = Date.UTC(2026, 6, 10, 12, 0, 0);
const DAY = 86400000;
const E_PAST = Date.UTC(2026, 6, 10, 8, 0, 0);
const E1 = Date.UTC(2026, 6, 11, 8, 0, 0); // +20h — the nearest live expiry
const E2 = Date.UTC(2026, 6, 12, 8, 0, 0); // +44h
const E3 = Date.UTC(2026, 6, 13, 8, 0, 0); // +68h — still ≤ 3d
const E_FAR = Date.UTC(2026, 6, 15, 8, 0, 0); // +116h — beyond the 3-day window

// pickExpiry only reads expiration_timestamp — a strike-less stub meta is enough for its tests.
const stub = (exp) => ({ instrument_name: `stub-${exp}`, expiration_timestamp: exp });

// --- pickExpiry ---------------------------------------------------------------------------------------

test("pickExpiry picks the NEAREST future expiry ≤3d from an unsorted chain with duplicates", () => {
  const chain = [E_FAR, E2, E_PAST, NOW, E1, E3, E1].map(stub); // NOW itself is NOT live (strictly >)
  assert.equal(pickExpiry(chain, NOW), E1);
});

test("pickExpiry ignores past expiries and expiries beyond maxDays → null when none qualify", () => {
  assert.equal(pickExpiry([E_PAST, E_FAR].map(stub), NOW), null);
  assert.equal(pickExpiry([stub(E_PAST)], NOW), null);
});

test("pickExpiry: an expiry exactly at nowMs + 3d is still included (boundary inclusive)", () => {
  assert.equal(pickExpiry([stub(NOW + 3 * DAY)], NOW), NOW + 3 * DAY);
});

test("pickExpiry: empty chain → null (both shapes)", () => {
  assert.equal(pickExpiry([], NOW), null);
  assert.equal(pickExpiry({ instruments: [] }, NOW), null);
});

test("pickExpiry accepts the { instruments:[...] } chain envelope too", () => {
  assert.equal(pickExpiry({ instruments: [stub(E2), stub(E1)] }, NOW), E1);
});

test("pickExpiry respects a custom maxDays", () => {
  assert.equal(pickExpiry([stub(E_FAR)], NOW, { maxDays: 7 }), E_FAR); // +116h fits a 7-day window
  assert.equal(pickExpiry([stub(E1), stub(E2)], NOW, { maxDays: 1 }), E1); // +44h no longer fits
  assert.equal(pickExpiry([stub(E2)], NOW, { maxDays: 1 }), null);
});

// --- auto ATM/wings: pickExpiry → buildStructure ------------------------------------------------------
// Both a call & a put at every 1000-strike from 50000..70000 for one expiry (Deribit-style names).
const ladder = (exp, dateCode) => {
  const metas = [];
  for (let k = 50000; k <= 70000; k += 1000) {
    for (const [ot, cp] of [["call", "C"], ["put", "P"]]) {
      metas.push({
        instrument_name: `BTC_USDC-${dateCode}-${k}-${cp}`,
        option_type: ot,
        strike: k,
        expiration_timestamp: exp,
        contract_size: 1,
        tick_size: 5,
        min_trade_amount: 0.01,
      });
    }
  }
  return metas;
};

// The live E1 ladder plus dead E_PAST/E_FAR ladders that pickExpiry must skip. underlying 63872.5 →
// atm = nearest on the 1000-grid = 64000; kc: 64000·1.10 = 70400 → 70000 (ladder top); kp: 64000·0.90
// = 57600 → 58000.
const chain = [...ladder(E_PAST, "10JUL26"), ...ladder(E1, "11JUL26"), ...ladder(E_FAR, "15JUL26")];
const snapshot = { underlying: 63872.5, legs: {} };

test("auto-construct: pickExpiry → E1; buildStructure resolves atm 64000 / kc 70000 / kp 58000", () => {
  const expiry = pickExpiry(chain, NOW);
  assert.equal(expiry, E1);

  const st = buildStructure({ expiry, callOffsetPct: 10, putOffsetPct: 10, qty: 0.01, execStyle: "limit" }, chain, snapshot);
  assert.equal(st.error, undefined);
  assert.equal(st.expiryMs, E1);
  assert.deepEqual(st.strikes, { atm: 64000, kc: 70000, kp: 58000 });
  assert.equal(st.legs.length, 4);

  const [c0, c1, c2, c3] = st.legs;
  assert.equal(c0.instrument, "BTC_USDC-11JUL26-64000-C"); assert.equal(c0.side, "long");
  assert.equal(c1.instrument, "BTC_USDC-11JUL26-64000-P"); assert.equal(c1.side, "long");
  assert.equal(c2.instrument, "BTC_USDC-11JUL26-70000-C"); assert.equal(c2.side, "short");
  assert.equal(c3.instrument, "BTC_USDC-11JUL26-58000-P"); assert.equal(c3.side, "short");
  for (const l of st.legs) {
    assert.equal(l.expiryMs, E1);
    assert.equal(l.qtyAbs, 0.01);
    near(Math.abs(l.qtySigned), 0.01, 1e-12, "qtySigned");
    assert.equal(l.minTradeAmount, 0.01); // falls back to the meta's min_trade_amount (no leg quotes)
  }
  assert.equal(st.entryUnderlying, 63872.5);
});

// --- structureRejections / validateStructure ----------------------------------------------------------
const metaByInstrument = Object.fromEntries(chain.map((m) => [m.instrument_name, m])); // min_trade_amount 0.01
const buildAt = (qty) =>
  buildStructure({ expiry: E1, callOffsetPct: 10, putOffsetPct: 10, qty, execStyle: "limit" }, chain, snapshot);

test("structureRejections: qty 0.005 (< min lot) → exactly one min_size block with the real numbers", () => {
  const r = structureRejections(buildAt(0.005), metaByInstrument);
  assert.equal(r.length, 1);
  assert.equal(r[0].code, "min_size");
  assert.equal(r[0].severity, "block");
  assert.ok(r[0].detail.includes("0.005"), r[0].detail);
  assert.ok(r[0].detail.includes("0.01"), r[0].detail);
});

test("structureRejections: qty 0.015 (off the 0.01 lot grid) → step_size block", () => {
  const r = structureRejections(buildAt(0.015), metaByInstrument);
  assert.equal(r.length, 1);
  assert.equal(r[0].code, "step_size");
  assert.equal(r[0].severity, "block");
  assert.ok(r[0].detail.includes("0.015"), r[0].detail);
  assert.ok(r[0].detail.includes("0.01"), r[0].detail);
});

test("structureRejections: qty 0.01 (on the lot grid) → no rejections", () => {
  assert.deepEqual(structureRejections(buildAt(0.01), metaByInstrument), []);
});

test("structureRejections: mismatched leg expiry → structure block (existing Russian wording)", () => {
  const s = buildAt(0.01);
  s.legs[3] = { ...s.legs[3], expiryMs: E1 + DAY };
  const r = structureRejections(s, metaByInstrument);
  assert.deepEqual(r, [{ code: "structure", severity: "block", detail: "Экспирации ног не совпадают" }]);
});

test("structureRejections: missing instrument meta → structure block naming the leg", () => {
  const s = buildAt(0.01);
  s.legs = s.legs.map((l) => ({ ...l, minTradeAmount: undefined })); // no meta AND no fallback lot
  const r = structureRejections(s, {});
  assert.equal(r.length, 1);
  assert.equal(r[0].code, "structure");
  assert.equal(r[0].severity, "block");
  assert.ok(r[0].detail.includes("нет метаданных инструмента"), r[0].detail);
  assert.ok(r[0].detail.includes(s.legs[0].instrument), r[0].detail);
});

test("validateStructure stays the thin { ok, errors } wrapper over the rejections", () => {
  for (const qty of [0.005, 0.015]) {
    const s = buildAt(qty);
    const v = validateStructure(s, metaByInstrument);
    assert.equal(v.ok, false);
    assert.deepEqual(v.errors, structureRejections(s, metaByInstrument).map((r) => r.detail));
  }
  assert.deepEqual(validateStructure(buildAt(0.01), metaByInstrument), { ok: true, errors: [] });
});

test("pickExpiry: minLeadMs skips an expiry already inside the pre-expiry blackout", () => {
  const soon = NOW + 10 * 60000; // 10 min out — inside a 30-min lead
  assert.equal(pickExpiry([stub(soon), stub(E1)].map((m) => m), NOW, { minLeadMs: 1800000 }), E1);
  assert.equal(pickExpiry([stub(soon)], NOW, { minLeadMs: 1800000 }), null);
});

// --- Phase 3a: the openStructure pre-trade gate (auto-pick + settlement + margin-warn) ------------------
import { create, openStructure, preTradeCheck } from "../src/engine/btcopt/engine.js";

// A two-expiry chain (E1 + E2 ladders) + a snapshot with the 2c margin-golden marks on the E1 legs:
// u 63872.5 / idx 63861.83 / short 70000-C mark 0.04 / short 58000-P mark 0.54 → IM ≈ $63.9 + $58.0 =
// $121.9 — the min-size straddle's real IM EXCEEDS the $100 paper deposit (the Phase-2c reality).
const chain2 = [...ladder(E1, "11JUL26"), ...ladder(E2, "12JUL26")];
const mkLeg = (mark) => ({ mark, contractSize: 1, minTradeAmount: 0.01, tickSize: 5, markInUsd: true });
const snap2 = {
  ts: NOW,
  underlying: 63872.5,
  index: 63861.83,
  legs: {
    "BTC_USDC-11JUL26-64000-C": mkLeg(430),
    "BTC_USDC-11JUL26-64000-P": mkLeg(410),
    "BTC_USDC-11JUL26-70000-C": mkLeg(0.04),
    "BTC_USDC-11JUL26-58000-P": mkLeg(0.54),
    // E2 legs quoted too: the auto-pick-skip test opens the NEXT expiry, and openStructure's
    // no_quote gate (audit №4) honestly blocks any leg the snapshot didn't price.
    "BTC_USDC-12JUL26-64000-C": mkLeg(510),
    "BTC_USDC-12JUL26-64000-P": mkLeg(490),
    "BTC_USDC-12JUL26-70000-C": mkLeg(0.11),
    "BTC_USDC-12JUL26-58000-P": mkLeg(1.4),
  },
};
const AUTO_PARAMS = { expiry: null, callOffsetPct: 10, putOffsetPct: 10, qty: 0.01, execStyle: "limit" };

test("openStructure auto-picks the nearest live expiry when params.expiry is null", () => {
  const st = create({ nowMs: NOW });
  const r = openStructure(st, AUTO_PARAMS, chain2, snap2, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.structure.expiryMs, E1);
  assert.deepEqual(r.structure.strikes, { atm: 64000, kc: 70000, kp: 58000 });
});

test("openStructure auto-pick skips an expiry inside the pre-expiry blackout → the NEXT one", () => {
  const st = create({ nowMs: NOW });
  const at = E1 - 20 * 60000; // 20 min before E1 (07:40 UTC — outside the ±10-min 08:00 window)
  const r = openStructure(st, AUTO_PARAMS, chain2, snap2, at);
  assert.equal(r.ok, true);
  assert.equal(r.structure.expiryMs, E2); // E1 is < 30 min out — never auto-open into delta decay
});

test("openStructure blocks in the 08:00 UTC settlement window with a structured settlement rejection", () => {
  const st = create({ nowMs: NOW });
  const at = Date.UTC(2026, 6, 10, 8, 5, 0); // inside ±600 s of 08:00 UTC
  const r = openStructure(st, { ...AUTO_PARAMS, expiry: E1 }, chain2, snap2, at);
  assert.ok(r.error && r.error.includes("окно расчёта 08:00 UTC"), r.error);
  assert.ok((r.rejections || []).some((x) => x.code === "settlement" && x.severity === "block"));
  assert.equal(st.structure, null); // nothing was opened
});

test("openStructure blocks < 30 min before the chosen expiry (pre-expiry reason)", () => {
  const st = create({ nowMs: NOW });
  const at = E1 - 20 * 60000;
  const r = openStructure(st, { ...AUTO_PARAMS, expiry: E1 }, chain2, snap2, at); // explicit E1 — no auto skip
  assert.ok(r.error && r.error.includes("<30 мин до экспирации"), r.error);
  assert.ok((r.rejections || []).some((x) => x.code === "settlement"));
});

test("openStructure: settlementBlackout=false disables the settlement gate (user's own call)", () => {
  const st = create({ nowMs: NOW, settings: { settlementBlackout: false } });
  const at = Date.UTC(2026, 6, 10, 8, 5, 0);
  const r = openStructure(st, { ...AUTO_PARAMS, expiry: E1 }, chain2, snap2, at);
  assert.equal(r.ok, true);
});

test("margin IM > deposit is a WARN that rides the OK response — opening proceeds (decision (b))", () => {
  const st = create({ nowMs: NOW });
  const r = openStructure(st, { ...AUTO_PARAMS, expiry: E1 }, chain2, snap2, NOW);
  assert.equal(r.ok, true); // warn never blocks
  const w = (r.rejections || []).find((x) => x.code === "margin");
  assert.ok(w, "margin warn present");
  assert.equal(w.severity, "warn");
  assert.ok(w.detail.includes("IM $122"), w.detail); // round(121.9) — the 2c golden reality
  assert.ok(w.detail.includes("депозит $100"), w.detail);
  assert.ok(st.structure, "structure IS open despite the warn");
});

test("margin warn disappears when the deposit covers the IM (paperEquityUsd 10000)", () => {
  const st = create({ nowMs: NOW, settings: { paperEquityUsd: 10000 } });
  const r = openStructure(st, { ...AUTO_PARAMS, expiry: E1 }, chain2, snap2, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rejections, []);
});

test("openStructure refuses a second open while a structure is running (no silent clobber)", () => {
  const st = create({ nowMs: NOW });
  const r1 = openStructure(st, { ...AUTO_PARAMS, expiry: E1 }, chain2, snap2, NOW);
  assert.equal(r1.ok, true);
  const id1 = st.structure.id;
  const ledgerLen = st.ledger.length;
  // A second open (double-click / retried IPC) must NOT orphan the running structure: its MtM is
  // realized only via closeStructure, and the perp hedge is sized for ITS legs.
  const r2 = openStructure(st, { ...AUTO_PARAMS, expiry: E2 }, chain2, snap2, NOW + 1000);
  assert.ok(r2.error && r2.error.includes("уже открыта"), r2.error);
  assert.equal(st.structure.id, id1, "first structure untouched");
  assert.equal(st.ledger.length, ledgerLen, "no extra open row in the ledger");
});

test("preTradeCheck composes: sub-min qty + blackout together (both blocks reported)", () => {
  const st = create({ nowMs: NOW });
  const at = Date.UTC(2026, 6, 10, 8, 3, 0);
  const built = buildStructure({ ...AUTO_PARAMS, expiry: E1, qty: 0.005 }, chain2, snap2);
  const metaBy = Object.fromEntries(chain2.map((m) => [m.instrument_name, m]));
  const rej = preTradeCheck(st, built, metaBy, snap2, at);
  const codes = rej.map((r) => r.code);
  assert.ok(codes.includes("min_size"), String(codes));
  assert.ok(codes.includes("settlement"), String(codes));
  assert.ok(!codes.includes("margin"), String(codes)); // half size ⇒ IM ≈ $61 < $100 — no margin warn
});

// ── Quote gate (audit №4): a leg the snapshot never priced must BLOCK the open, naming culprits ──
test("openStructure blocks when a leg has no quote in the snapshot (no_quote names the culprits)", () => {
  const st = create({ nowMs: NOW });
  const snapMissing = { ...snap2, legs: { ...snap2.legs } };
  delete snapMissing.legs["BTC_USDC-11JUL26-58000-P"];
  const r = openStructure(st, { ...AUTO_PARAMS, expiry: E1 }, chain2, snapMissing, NOW);
  assert.ok(r.error && r.error.includes("нет котировки"), r.error);
  assert.ok(r.error.includes("BTC_USDC-11JUL26-58000-P"), r.error);
  assert.ok((r.rejections || []).some((x) => x.code === "no_quote" && x.severity === "block"));
  assert.equal(st.structure, null, "nothing was opened on a half-priced snapshot");
});

test("preTradeCheck no_quote lists EVERY unquoted leg (sweep surfaces this reason verbatim)", () => {
  const st = create({ nowMs: NOW });
  const snapMissing = { ...snap2, legs: { ...snap2.legs } };
  delete snapMissing.legs["BTC_USDC-11JUL26-58000-P"];
  delete snapMissing.legs["BTC_USDC-11JUL26-70000-C"];
  const built = buildStructure({ expiry: E1, callOffsetPct: 10, putOffsetPct: 10, qty: 0.01, execStyle: "limit" }, chain2, snapMissing);
  const metaBy = Object.fromEntries(chain2.map((m) => [m.instrument_name, m]));
  const rej = preTradeCheck(st, built, metaBy, snapMissing, NOW).filter((x) => x.code === "no_quote");
  assert.equal(rej.length, 1, "one rejection naming all culprits");
  assert.ok(rej[0].detail.includes("58000-P") && rej[0].detail.includes("70000-C"), rej[0].detail);
});
