// otmscan-sellstrangle.test.js - правила стрэнгла продавца (sellstrangle.js).
// Проверяется главное решение модуля: своей протяжки у стрэнгла НЕТ - walkSellTrade ведёт пару
// через составную цену, полоса работает по НЕТТО-дельте, выход в экспирацию отдаёт сумму
// внутренних стоимостей, а неоценённая нога роняет всю сделку, как того требует правило лестницы.

import test from "node:test";
import assert from "node:assert/strict";
import { SELLHEDGE_DEFAULTS, walkSellTrade, settleSellTrade, stepMtm } from "../src/engine/otmscan/sellhedge.js";
import { pickStranglePair, rankStranglePairs, openStrangleTrade, stranglePrice } from "../src/engine/otmscan/sellstrangle.js";
import { near } from "./otmscan-helpers.mjs";

const C = SELLHEDGE_DEFAULTS;
const row = (over = {}) => ({ n: "BTC-1JAN26-100000-C", e: 1000, k: 100000, s: "C", h: 480,
  m: 3000, d: 0.45, b: 2950, a: 3050, iv: 45, vg: 120, ...over });

// ── пара ног
test("пара: колл базовым правилом, пут ТОЙ ЖЕ экспирации, каждый ближайший по |дельте|", () => {
  const rows = [
    row({ n: "c-hit", d: 0.47 }), row({ n: "c-far", d: 0.36 }),
    row({ n: "p-hit", s: "P", d: -0.44 }), row({ n: "p-far", s: "P", d: -0.55 }),
  ];
  const pair = pickStranglePair(rows, C);
  assert.equal(pair.call.n, "c-hit");
  assert.equal(pair.put.n, "p-hit");
});

test("пара: пут ЧУЖОЙ экспирации не берётся, даже когда он ближе по дельте", () => {
  const rows = [
    row({ n: "call", d: 0.45 }),
    row({ n: "p-other", s: "P", d: -0.45, e: 2000 }), // идеальная дельта, но другая экспирация
    row({ n: "p-same", s: "P", d: -0.52 }),
  ];
  assert.equal(pickStranglePair(rows, C).put.n, "p-same");
});

test("пара: нет пута в допуске - входа нет вовсе, а не «колл без пары»", () => {
  assert.equal(pickStranglePair([row()], C), null, "пута нет совсем");
  assert.equal(pickStranglePair([row(), row({ n: "p-out", s: "P", d: -0.70 })], C), null,
    "пут вне допуска дельты");
  assert.equal(pickStranglePair([row({ s: "P", d: -0.45 })], C), null, "нет колла - нет и пары");
});

test("пара: rows обязан быть массивом - итератор снимка здесь не чинится молча", () => {
  const rows = [row(), row({ n: "p", s: "P", d: -0.45 })];
  assert.equal(pickStranglePair(new Map(rows.map((r) => [r.n, r])).values(), C), null);
});

// ── очередь пар (санитария §1.8 живого тракта): вето переключает ПАРУ, поэтому вызывающему нужна
// очередь запасных; колл без пута своей экспирации пропускается ПРАВИЛОМ (структурное отсутствие).
test("очередь: пары идут в порядке близости колла, лучший колл без пута пропускается правилом", () => {
  const rows = [
    row({ n: "c-best", d: 0.45, e: 111 }), // лучший колл, но у e=111 пута нет вовсе
    row({ n: "c-2nd", d: 0.50, e: 222 }),
    row({ n: "p-2nd", s: "P", d: -0.46, e: 222 }),
    row({ n: "c-3rd", d: 0.54, e: 333 }),
    row({ n: "p-3rd", s: "P", d: -0.44, e: 333 }),
  ];
  const q2 = rankStranglePairs(rows, C, 2);
  assert.deepEqual(q2.map((p) => p.call.n), ["c-2nd", "c-3rd"], "порядок по дельте колла, дырка пропущена");
  assert.deepEqual(q2.map((p) => p.put.n), ["p-2nd", "p-3rd"], "пут своей экспирации у каждой пары");
  assert.equal(rankStranglePairs(rows, C, 1).length, 1, "limit режет очередь, а не пул коллов");
});

test("очередь: pickStranglePair это ровно первая пара очереди - одно правило, не два", () => {
  const rows = [
    row({ n: "c-best", d: 0.45, e: 111 }),
    row({ n: "c-2nd", d: 0.50, e: 222 }),
    row({ n: "p-2nd", s: "P", d: -0.46, e: 222 }),
  ];
  assert.equal(pickStranglePair(rows, C).call.n, "c-2nd", "структурная дырка не замораживает вход");
  assert.equal(pickStranglePair(rows, C).call.n, rankStranglePairs(rows, C, 1)[0].call.n);
});

// ── вход
test("вход: премии и издержки ног складываются, хедж равен НЕТТО-дельте пары", () => {
  const pair = { call: row({ d: 0.45 }), put: row({ n: "p", s: "P", d: -0.41, m: 2600 }) };
  const o = openStrangleTrade({ pair, spotUsd: 100000, costsCall: { roundTripCostPct: 4 },
    costsPut: { roundTripCostPct: 5 }, imUsd: 21000, cfg: C });
  near(o.premSold, 3000 + 2600, 1e-12, "сумма премий");
  near(o.optCost, (4 / 100) * 3000 / 2 + (5 / 100) * 2600 / 2, 1e-12, "каждая нога платит половину СВОЕГО круга");
  near(o.qPerp, 0.45 - 0.41, 1e-12, "нетто-дельта: пут тянет хедж в минус");
  assert.equal(o.imUsd, 21000, "залог приходит от вызывающего суммой ног");
});

test("вход: комиссия хеджа берётся с НЕТТО-оборота, перп входит одной сделкой", () => {
  const pair = { call: row({ d: 0.45 }), put: row({ n: "p", s: "P", d: -0.41 }) };
  const o = openStrangleTrade({ pair, spotUsd: 100000, costsCall: { roundTripCostPct: 4 },
    costsPut: { roundTripCostPct: 4 }, imUsd: 21000, cfg: { ...C, perpFee: 0.0005 } });
  near(o.hedgeFee, Math.abs(0.45 - 0.41) * 100000 * 0.0005, 1e-9,
    "|нетто| × спот × ставка, а не сумма модулей ног");
});

test("вход: нога без цены роняет вход целиком - оценка вместо наблюдения запрещена", () => {
  const pair = { call: row(), put: row({ n: "p", s: "P", d: -0.45, m: 0 }) };
  assert.equal(openStrangleTrade({ pair, spotUsd: 100000, costsCall: { roundTripCostPct: 4 },
    costsPut: { roundTripCostPct: 4 }, imUsd: 21000, cfg: C }), null);
});

// ── составная цена
test("цена шага: сумма марков и сумма дельт; пропала нога - null на весь шаг", () => {
  const p = stranglePrice({ markUsd: 3000, delta: 0.45 }, { markUsd: 2600, delta: -0.41 });
  near(p.markUsd, 5600, 1e-12);
  near(p.delta, 0.04, 1e-12);
  assert.equal(stranglePrice(null, { markUsd: 2600, delta: -0.41 }), null);
  assert.equal(stranglePrice({ markUsd: 3000, delta: 0.45 }, null), null);
});

test("цена шага: неизвестная дельта ноги делает неизвестной дельту ПАРЫ, а не «хеджируем что знаем»", () => {
  const p = stranglePrice({ markUsd: 3000, delta: 0.45 }, { markUsd: 2600, delta: null });
  near(p.markUsd, 5600, 1e-12, "марк складывается: он известен");
  assert.equal(p.delta, null, "дельта - нет");
});

// ── интеграция с протяжкой: стрэнгл идёт ЧЕРЕЗ walkSellTrade, своей протяжки у него нет
test("протяжка пары: полоса решает по нетто-дельте, экспирация отдаёт сумму внутренних", () => {
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  // Колл: дельта растёт 0.45 → 0.85; пут: -0.41 всё время. Нетто уходит 0.04 → 0.44, то есть за
  // полосу 0.03 на первом же шаге. Экспирация на шаге 4: спот 110000, страйки 100000/90000.
  const dC = (k) => 0.45 + 0.1 * k;
  const priceAt = (k) => stranglePrice(
    { markUsd: k === 4 ? 10000 : 3000 + 500 * k, delta: dC(k) },
    { markUsd: k === 4 ? 0 : 2600 - 300 * k, delta: -0.41 },
  );
  const entry = { qPerp: 0.45 - 0.41, hedgeFee: 0 };
  const w = walkSellTrade({
    count: 5,
    tsAt: (k) => T0 + (k + 1) * 3600000,
    spotAt: () => 100000,
    priceAt,
    fundRateAt: () => 0,
    expiryMs: T0 + 5 * 3600000,
    entry, entryTsMs: T0, entrySpot: 100000, cfg: C,
  });
  assert.equal(w.exitIndex, 4, "единственный выход - экспирация, как у одной ноги");
  near(w.exitVal, 10000, 1e-12, "сумма внутренних стоимостей ног (пут кончился вне денег)");
  assert.equal(w.rehedges, 4, "вход + перекладка на каждом шаге дрейфа нетто-дельты до экспирации");
  // На последнем до-экспирационном шаге позиция хеджа равна нетто-дельте этого шага.
  near(w.hedgePnl, 0, 1e-12, "спот не двигался - хедж ничего не заработал");
});

test("протяжка пары: неоценённая нога роняет ВСЮ сделку правилом walkSellTrade", () => {
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  const w = walkSellTrade({
    count: 3,
    tsAt: (k) => T0 + (k + 1) * 3600000,
    spotAt: () => 100000,
    priceAt: (k) => stranglePrice({ markUsd: 3000, delta: 0.45 },
      k === 1 ? null : { markUsd: 2600, delta: -0.41 }),
    fundRateAt: () => 0,
    expiryMs: T0 + 3 * 3600000,
    entry: { qPerp: 0.04, hedgeFee: 0 }, entryTsMs: T0, entrySpot: 100000, cfg: C,
  });
  assert.equal(w, null);
});

test("итог пары: settleSellTrade и stepMtm работают без правок - конвенция одна на схему", () => {
  const open = { premSold: 5600, optCost: 125, imUsd: 21000, qPerp: 0.04, hedgeFee: 0 };
  const walk = { exitVal: 10000, exitIndex: 4, hedgePnl: 4400, hedgeFee: 0, funding: -30, rehedges: 4 };
  const s = settleSellTrade({ open, walk, cfg: C });
  near(s.pnl, (5600 - 10000) + 4400 - 125 + 30, 1e-9, "премии − выкуп + хедж − издержки − фандинг");
  const step = { mark: 10000, hedgePnl: 4400, hedgeFee: 0, funding: -30 };
  near(stepMtm({ premSold: 5600, optCost: 125, step, cfg: C }), s.pnl, 1e-9,
    "МтМ экспирационного шага при бесплатном перпе равен итогу - как у одной ноги");
});
