// otmscan-hist-price.test.js - лестница цены (hist-price.js). Проверяется прежде всего то, ради
// чего модуль заведён: позиция НЕ ИСЧЕЗАЕТ, когда строки инструмента в снимке нет, и каждая
// ступень честно называет себя в поле `how`.

import test from "node:test";
import assert from "node:assert/strict";
import { priceAt, siblingName, makePriceStats, countPrice, formatPriceStats } from "../src/engine/otmscan/hist-price.js";
import { black76Greeks } from "../src/engine/otmscan/black76.js";
import { near } from "./otmscan-helpers.mjs";

const TS = Date.parse("2026-01-01T00:00:00Z");
const EXP = Date.parse("2026-01-22T00:00:00Z"); // 21 сутки
const F = 100000, K = 102000, IV = 45;
const H = (EXP - TS) / 3600000;
const row = (name, over = {}) => ({ n: name, e: EXP, k: K, f: F, iv: IV, h: H, m: 1234, d: 0.45, ...over });

test("брат определяется на обеих цепочках и только для опционов", () => {
  assert.equal(siblingName("BTC_USDC-22JAN26-102000-C"), "BTC_USDC-22JAN26-102000-P");
  assert.equal(siblingName("BTC-22JAN26-102000-P"), "BTC-22JAN26-102000-C");
  assert.equal(siblingName("BTC-PERPETUAL"), null);
  assert.equal(siblingName(""), null);
  assert.equal(siblingName(null), null);
});

test("ступень row: строка есть, берём её как есть", () => {
  const snap = new Map([["X-C", row("X-C", { m: 2222, iv: 41, d: 0.5 })]]);
  const r = priceAt({ snapshot: snap, meta: { name: "X-C", expiryMs: EXP, strikeUsd: K, type: "C" }, tsMs: TS });
  assert.equal(r.how, "row");
  assert.equal(r.markUsd, 2222);
  assert.equal(r.ivPct, 41);
  assert.equal(r.delta, 0.5);
});

test("ступень parity: строки нет, брат жив - цена ТОЧНАЯ по Блэку-76, а не оценка", () => {
  const snap = new Map([["X-P", row("X-P", { m: 3000 })]]);
  const r = priceAt({ snapshot: snap, meta: { name: "X-C", expiryMs: EXP, strikeUsd: K, type: "C" }, tsMs: TS });
  assert.equal(r.how, "parity");
  const truth = black76Greeks({ forwardUsd: F, strikeUsd: K, ivPct: IV,
    tYears: (EXP - TS) / (365 * 86400000), optionType: "call" });
  near(r.markUsd, truth.priceUsd, 1e-9, "цена совпадает с прямым расчётом");
  near(r.delta, truth.delta, 1e-9, "дельта тоже");
  assert.equal(r.ivPct, IV, "волатильность берётся у брата");
});

test("ступень nearIv: нет ни строки, ни брата - берём IV ближайшего страйка той же экспирации", () => {
  const rows = [row("A-C", { k: 90000 }), row("B-C", { k: 101000, iv: 50 }), row("C-C", { k: 130000 })];
  const r = priceAt({ snapshot: new Map(), expiryRows: rows,
    meta: { name: "X-C", expiryMs: EXP, strikeUsd: K, type: "C" }, tsMs: TS });
  assert.equal(r.how, "nearIv");
  assert.equal(r.ivPct, 50, "взят страйк 101000, он ближе прочих к 102000");
  assert.ok(r.markUsd > 0);
});

test("ступень expired: после экспирации итог точный, по внутренней стоимости индекса", () => {
  const call = priceAt({ snapshot: new Map(), meta: { name: "X-C", expiryMs: EXP, strikeUsd: K, type: "C" },
    tsMs: EXP + 3600000, spotAtExpiry: 110000 });
  assert.equal(call.how, "expired");
  near(call.markUsd, 8000, 1e-9, "колл в деньгах на 8000");
  const put = priceAt({ snapshot: new Map(), meta: { name: "X-P", expiryMs: EXP, strikeUsd: K, type: "P" },
    tsMs: EXP, spotAtExpiry: 110000 });
  near(put.markUsd, 0, 1e-9, "пут истёк пустым, а не отрицательным");
});

test("ГЛАВНОЕ: глубоко в деньгах строки нет, брат жив - позиция НЕ исчезает", () => {
  // Ровно тот случай, что стоил проекту знака результата: спот ушёл далеко за страйк, колл
  // вылетел за сетку издержек и не был записан, а пут того же страйка остался.
  const deepF = 130000;
  const snap = new Map([["X-P", row("X-P", { f: deepF, iv: 55 })]]);
  const r = priceAt({ snapshot: snap, meta: { name: "X-C", expiryMs: EXP, strikeUsd: K, type: "C" }, tsMs: TS });
  assert.equal(r.how, "parity");
  assert.ok(r.markUsd > deepF - K - 1, `цена не ниже внутренней стоимости ${deepF - K}, получено ${r.markUsd}`);
});

test("null только когда оценить нечем, и он отличим от нуля", () => {
  const nothing = priceAt({ snapshot: new Map(), meta: { name: "X-C", expiryMs: EXP, strikeUsd: K, type: "C" }, tsMs: TS });
  assert.equal(nothing, null, "ни строки, ни брата, ни соседа");
  const noSpot = priceAt({ snapshot: new Map(), meta: { name: "X-C", expiryMs: EXP, strikeUsd: K, type: "C" },
    tsMs: EXP + 1 });
  assert.equal(noSpot, null, "экспирация прошла, но индекса не дали");
  assert.equal(priceAt({ meta: { name: "X-C", expiryMs: EXP, strikeUsd: K, type: "X" }, tsMs: TS }), null, "чужой тип");
  assert.equal(priceAt({ meta: null, tsMs: TS }), null);
});

test("строка с нулевым или отрицательным марком не считается наблюдением", () => {
  const snap = new Map([["X-C", row("X-C", { m: 0 })], ["X-P", row("X-P", { m: 500 })]]);
  const r = priceAt({ snapshot: snap, meta: { name: "X-C", expiryMs: EXP, strikeUsd: K, type: "C" }, tsMs: TS });
  assert.equal(r.how, "parity", "падаем на брата, а не принимаем нулевой марк");
});

test("счётчик ступеней складывает и печатает доли", () => {
  const st = makePriceStats();
  countPrice(st, { how: "row" });
  countPrice(st, { how: "row" });
  countPrice(st, { how: "parity" });
  countPrice(st, null);
  assert.equal(st.row, 2);
  assert.equal(st.parity, 1);
  assert.equal(st.none, 1);
  const s = formatPriceStats(st);
  assert.match(s, /оценок 4/);
  assert.match(s, /строка 50\.00%/);
  assert.match(s, /не вышло 25\.00%/);
});
