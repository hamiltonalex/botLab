// btcopt-margin.test.js — golden Deribit STANDARD-MARGIN for the short winged-straddle legs (Phase 2c):
// LINEAR/USDC BTC formulas (0.15/0.10/0.075), per-leg sum, no netting; long legs contribute 0. PURE,
// inline fixtures. Numbers use the recorded-snapshot underlying/index (test/fixtures/deribit/live-snapshot).
import test from "node:test";
import assert from "node:assert/strict";
import { legMargin, structureMargin, liqPriceEst } from "../src/engine/btcopt/margin.js";

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

// ── liqPriceEst: цена индекса, на которой оценка MM достигает equity (ревизия 2026-08-25 Р1).
// Модель: марк = внутренняя стоимость при I плюс ТЕКУЩАЯ временная; equity константа.

// Числа живой сделки mbp15 (снято 2026-08-25 10:51 UTC): продан колл 70000 × 1.13, марк 9626.61,
// индекс 79342, equity 19153.54. Замкнутая форма для колла в деньгах:
//   (0.075·I + (I − K) + tv)·amt = eq  ⇒  I = (eq/amt − tv + K) / 1.075,  tv = mark − (I0 − K).
test("liqPriceEst: короткий колл в деньгах - точное пересечение по замкнутой форме (живая сделка)", () => {
  const structure = { legs: [{ instrument: "C", type: "call", side: "short", strike: 70000, qtyAbs: 1.13 }] };
  const snapshot = { underlying: 79342, index: 79342, legs: { C: { mark: 9626.61 } } };
  const eq = 19153.54;
  const tv = 9626.61 - (79342 - 70000);
  const want = (eq / 1.13 - tv + 70000) / 1.075;
  const got = liqPriceEst(structure, snapshot, eq);
  near(got, want, 1e-6, "пересечение MM=equity вверх");
  assert.ok(got > 80000 && got < 81500, `правдоподобие: ~80.6k, got ${got}`);
});

test("liqPriceEst: MM уже на уровне equity и выше → текущий индекс (запас нулевой)", () => {
  const structure = { legs: [{ instrument: "C", type: "call", side: "short", strike: 70000, qtyAbs: 1.13 }] };
  const snapshot = { underlying: 79342, index: 79342, legs: { C: { mark: 9626.61 } } };
  // mm0 = (0.075·79342 + 9626.61)·1.13 ≈ 17602 > 17000
  assert.equal(liqPriceEst(structure, snapshot, 17000), 79342);
});

test("liqPriceEst: короткий пут - пересечение на нижней стороне, выше страйка MM не растёт", () => {
  const structure = { legs: [{ instrument: "P", type: "put", side: "short", strike: 60000, qtyAbs: 1 }] };
  const snapshot = { underlying: 79342, index: 79342, legs: { P: { mark: 500 } } };
  // ниже страйка: mm = 0.075·I + (60000 − I) + 500 = 60500 − 0.925·I = 10000 ⇒ I = 50500/0.925
  near(liqPriceEst(structure, snapshot, 10000), 50500 / 0.925, 1e-6, "нижнее пересечение");
});

test("liqPriceEst: крылатый стрэддл - из двух пересечений возвращается ближайшее", () => {
  const structure = { legs: [
    { instrument: "C", type: "call", side: "short", strike: 70000, qtyAbs: 1 },
    { instrument: "P", type: "put", side: "short", strike: 50000, qtyAbs: 1 },
    { instrument: "CL", type: "call", side: "long", strike: 60000, qtyAbs: 1 },
  ] };
  const snapshot = { underlying: 60000, index: 60000, legs: { C: { mark: 200 }, P: { mark: 200 } } };
  // вверх: изломы на 70000; за ним наклон 1.075 (колл в деньгах, пут заморожен на min=K):
  //   mm(70000) = (5250+200) + (0.075·50000+200) = 9400 ⇒ I = 70000 + (12000−9400)/1.075 ≈ 72418.6
  // вниз: mm(50000) = 7900, наклон −0.85 ⇒ I ≈ 45176.5 - дальше от 60000, чем верхнее.
  near(liqPriceEst(structure, snapshot, 12000), 70000 + 2600 / 1.075, 1e-6, "ближайшее (верхнее)");
});

test("liqPriceEst: нет коротких ног / нет структуры / нет индекса → null", () => {
  const snapshot = { underlying: 60000, index: 60000, legs: {} };
  assert.equal(liqPriceEst(null, snapshot, 1000), null);
  assert.equal(liqPriceEst({ legs: [] }, snapshot, 1000), null);
  assert.equal(liqPriceEst({ legs: [{ type: "call", side: "long", strike: 60000, qtyAbs: 1 }] }, snapshot, 1000), null);
  assert.equal(liqPriceEst({ legs: [{ type: "call", side: "short", strike: 60000, qtyAbs: 1 }] }, { legs: {} }, 1000), null);
});

test("liqPriceEst: далеко не в деньгах и огромный счёт → пересечение есть и конечно (вверх тянет колл)", () => {
  const structure = { legs: [{ instrument: "C", type: "call", side: "short", strike: 70000, qtyAbs: 0.01 }] };
  const snapshot = { underlying: 61000, index: 61000, legs: { C: { mark: 30 } } };
  const got = liqPriceEst(structure, snapshot, 5000);
  // (0.075·I + (I−70000) + 30)·0.01 = 5000 ⇒ I = (500000 − 30 + 70000)/1.075
  near(got, (5000 / 0.01 - 30 + 70000) / 1.075, 1e-6, "далёкое верхнее пересечение");
});
