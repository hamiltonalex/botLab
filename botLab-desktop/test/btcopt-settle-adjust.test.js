// btcopt-settle-adjust.test.js — S0: сверка расчёта экспирации с официальной delivery-ценой
// (P0 аудита 2026-07-19). Покрывает: meta-паттерн строк журнала, meta на settle-строке движка,
// planSettleAdjustments (сверка/пропуски/повторы) и сохранение сверки журнала после поправки.

import test from "node:test";
import assert from "node:assert/strict";
import * as s1engine from "../src/engine/btcopt/engine.js";
import { appendLedger, planSettleAdjustments, ledgerReconciles } from "../src/engine/btcopt/pnl.js";
import { intrinsicAt } from "../src/engine/btcopt/payoff.js";

const EXPIRY = Date.UTC(2026, 6, 18, 8); // 08:00 UTC → дата delivery "2026-07-18"
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) < tol, `${label}: got ${a}, want ${b}`);

const mkStructure = () => ({
  id: `s1-${EXPIRY}-100-0`,
  expiryMs: EXPIRY,
  createdAt: 0,
  strikes: { atm: 100, kc: 110, kp: 90 },
  entryDebitUsd: 5,
  params: {},
  legs: [
    { instrument: "C-ATM", type: "call", side: "long", strike: 100, qtyAbs: 0.01, qtySigned: 0.01, contractSize: 1, entryMark: 300 },
    { instrument: "P-ATM", type: "put", side: "long", strike: 100, qtyAbs: 0.01, qtySigned: 0.01, contractSize: 1, entryMark: 280 },
    { instrument: "C-OTM", type: "call", side: "short", strike: 110, qtyAbs: 0.01, qtySigned: -0.01, contractSize: 1, entryMark: 40 },
    { instrument: "P-OTM", type: "put", side: "short", strike: 90, qtyAbs: 0.01, qtySigned: -0.01, contractSize: 1, entryMark: 35 },
  ],
});

test("appendLedger: meta проезжает целиком, строки без meta не получают ключа", () => {
  const st = s1engine.create({ nowMs: 0 });
  const plain = appendLedger(st, { t: 1, type: "open" });
  const withMeta = appendLedger(st, { t: 2, type: "settle-options", meta: { expiryMs: EXPIRY } });
  assert.ok(!("meta" in plain));
  assert.deepEqual(withMeta.meta, { expiryMs: EXPIRY });
  assert.equal(withMeta.seq, 2);
});

test("settleStructure: settle-строка несёт meta {expiryMs, strikes, unit} и правильный payoff", () => {
  const st = s1engine.create({ nowMs: 0 });
  st.structure = mkStructure();
  const res = s1engine.settleStructure(st, { index: 95 }, EXPIRY + 1000);
  assert.equal(res.settled, true);
  const row = st.ledger.find((r) => r.type === "settle-options");
  assert.ok(row, "settle-строка существует");
  assert.deepEqual(row.meta, { expiryMs: EXPIRY, strikes: { atm: 100, kc: 110, kp: 90 }, unit: 0.01 });
  // интринсик пута 100−95=5 на unit 0.01 минус дебет 5 → −4.95
  near(row.realizedUsd, 0.01 * intrinsicAt(row.meta.strikes, 95) - 5, 1e-12, "payoff на прокси");
});

test("planSettleAdjustments: поправка = unit·(intr(delivery) − intr(proxy)); пропуски и повторы", () => {
  const st = s1engine.create({ nowMs: 0 });
  st.structure = mkStructure();
  s1engine.settleStructure(st, { index: 95 }, EXPIRY + 1000);

  // даты ещё нет в таблице delivery — план пуст, строка остаётся pending
  assert.deepEqual(planSettleAdjustments(st.ledger, {}), []);

  const plans = planSettleAdjustments(st.ledger, { "2026-07-18": 93 });
  assert.equal(plans.length, 1);
  const p = plans[0];
  assert.equal(p.date, "2026-07-18");
  assert.equal(p.proxyPrice, 95);
  assert.equal(p.deliveryPrice, 93);
  near(p.adjustUsd, 0.01 * ((100 - 93) - (100 - 95)), 1e-12, "поправка"); // +0.02

  // применяем как main: аккумулятор + строка-пара → строка больше не pending, сверка журнала цела
  st.realizedOptionsUsd += p.adjustUsd;
  appendLedger(st, {
    t: EXPIRY + 2000, type: "settle-adjust", priceRef: p.deliveryPrice, realizedUsd: p.adjustUsd,
    meta: { srcSeq: p.srcSeq, date: p.date, proxyPrice: p.proxyPrice, deliveryPrice: p.deliveryPrice },
  });
  assert.deepEqual(planSettleAdjustments(st.ledger, { "2026-07-18": 93 }), []);
  assert.equal(ledgerReconciles(st, { legs: {} }).ok, true);
});

test("planSettleAdjustments: строки без meta (до-S0 состояния) пропускаются молча", () => {
  const st = s1engine.create({ nowMs: 0 });
  appendLedger(st, { t: 1, type: "settle-options", priceRef: 95, realizedUsd: -1 }); // legacy: без meta
  assert.deepEqual(planSettleAdjustments(st.ledger, { "2026-07-18": 93 }), []);
});
