// btcopt-deribit.test.js - the greeks gate (pure part of deribit.js). The load-bearing case: a
// primary (open-structure) leg whose fetch failed entirely is ABSENT from the legs map - the gate
// must fail on the missing name, not pass on the valid survivors (a missing leg's delta would
// otherwise silently count as 0 and the engine would hedge off an understated net delta).
// PURE, inline fixtures, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { greeksGateOk, tickerToPerp } from "../src/engine/btcopt/deribit.js";

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
      ? { instrument_name: name, instrument_type: "reversed", contract_size: 10, tick_size: 0.5, min_trade_amount: 10, maker_commission: 0.00015, taker_commission: 0.00035 }
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

// ── Справочный спот (pickSpotRef): свежайшая нога вместо гонки Promise.all; протухшая метка
// (истёкший инструмент Deribit ~сутки отвечает замороженным тикером state "delivered") означает
// фолбэк на живой индекс перпа. Дефект живого прогона 24-25.08.2026: S залип на 77394.16 в 2200
// тиках 86 эпизодами (эпизод = серия тиков, где гонку выигрывала замороженная нога) при живом idx.
import { pickSpotRef, SPOT_STALE_MS } from "../src/engine/btcopt/deribit.js";

const NOW = 1787900000000;
const uLeg = (underlying, ts, name = "L") => ({ instrument: name, underlying, ts });

test("спот: побеждает нога с НОВЕЙШЕЙ меткой, порядок массива (гонка fetch) не решает", () => {
  const a = uLeg(77394.16, NOW - 3600000, "DEAD");
  const b = uLeg(80500, NOW - 2000, "LIVE");
  for (const legs of [[a, b], [b, a]]) {
    const r = pickSpotRef({ legs, perp: { index: 80480 }, nowMs: NOW });
    assert.equal(r.underlying, 80500, "спот со свежайшей ноги");
    assert.equal(r.spot.source, "options");
    assert.equal(r.spot.stale, false);
    assert.equal(r.spot.ts, NOW - 2000);
  }
});

test("спот: единственная нога протухла → индекс перпа, stale и возраст названы", () => {
  const r = pickSpotRef({ legs: [uLeg(77394.16, NOW - 20.6 * 3600000)], perp: { index: 80480 }, nowMs: NOW });
  assert.equal(r.underlying, 80480, "взят живой индекс, а не замороженный форвард");
  assert.equal(r.spot.source, "index");
  assert.equal(r.spot.stale, true);
  assert.ok(Math.abs(r.spot.ageSec - 20.6 * 3600) < 1, "возраст опционного спота в секундах");
});

test("спот: порог SPOT_STALE_MS включительно свеж, дальше протух", () => {
  const at = (ageMs) => pickSpotRef({ legs: [uLeg(100, NOW - ageMs)], perp: { index: 200 }, nowMs: NOW });
  assert.equal(at(SPOT_STALE_MS).underlying, 100, "ровно на пороге ещё свеж");
  assert.equal(at(SPOT_STALE_MS + 1).underlying, 200, "за порогом - индекс");
});

test("спот: протух, а перпа нет → значение оставлено и помечено stale-options", () => {
  const r = pickSpotRef({ legs: [uLeg(77394.16, NOW - 3600000)], perp: null, nowMs: NOW });
  assert.equal(r.underlying, 77394.16, "лучше помеченное старое, чем ничего");
  assert.equal(r.spot.source, "stale-options");
  assert.equal(r.spot.stale, true);
});

test("спот: нога без конечной метки тикера спотом не становится (свежесть не доказать)", () => {
  const r = pickSpotRef({ legs: [{ underlying: 100, ts: null }], perp: { index: 200 }, nowMs: NOW });
  assert.equal(r.underlying, 200);
  assert.equal(r.spot.source, "index");
  assert.equal(r.spot.stale, false, "нет пригодной ноги - протухать нечему");
  assert.equal(r.spot.ageSec, null);
});

test("спот: ни ног, ни перпа → null и source null (строители честно откажут)", () => {
  const r = pickSpotRef({ legs: [], perp: null, nowMs: NOW });
  assert.equal(r.underlying, null);
  assert.equal(r.spot.source, null);
});

// Сквозной сценарий дефекта через buildDeribitSnapshot: замороженная нога (метка на 20 часов
// старше nowMs) против живой. Раньше S зависел от порядка завершения fetch; теперь - нет.
function stubFrozenFetch({ frozenName, frozenTs, liveTs }) {
  const envelope = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", result, usDiff: 1000 }) });
  const ticker = (name) => {
    if (name === "BTC-PERPETUAL")
      return { mark_price: 80480, index_price: 80480, best_bid_price: 80479, best_ask_price: 80481, funding_8h: 0.0001, current_funding: 0.0001, timestamp: liveTs };
    const frozen = name === frozenName;
    return { mark_price: 900, best_bid_price: 890, best_ask_price: 910, mark_iv: 45, index_price: frozen ? 77394.16 : 80480,
      underlying_price: frozen ? 77394.16 : 80500, timestamp: frozen ? frozenTs : liveTs,
      greeks: { delta: 0.5, gamma: 0.0001, vega: 12, theta: -30, rho: 1 } };
  };
  const meta = (name) =>
    name === "BTC-PERPETUAL"
      ? { instrument_name: name, instrument_type: "reversed", contract_size: 10, tick_size: 0.5, min_trade_amount: 10 }
      : { instrument_name: name, option_type: "call", strike: 80000, expiration_timestamp: 1790000000000, contract_size: 1, tick_size: 5, min_trade_amount: 0.01, quote_currency: "USDC", settlement_currency: "USDC" };
  return async (url) => {
    const u = new URL(String(url));
    const name = u.searchParams.get("instrument_name");
    if (u.pathname.endsWith("/public/ticker")) return envelope(ticker(name));
    if (u.pathname.endsWith("/public/get_instrument")) return envelope(meta(name));
    return envelope({});
  };
}

test("снапшот: замороженная нога рядом с живой → S с живой; одна замороженная → S = индекс + заметка", async () => {
  const real = global.fetch;
  const frozenTs = NOW - 20 * 3600000;
  try {
    global.fetch = stubFrozenFetch({ frozenName: "DEAD-LEG", frozenTs, liveTs: NOW });
    const both = await buildDeribitSnapshot({ legInstruments: ["DEAD-LEG", "LIVE-LEG"], primaryInstruments: [], nowMs: NOW });
    assert.equal(both.underlying, 80500, "живая нога побеждает независимо от порядка завершения");
    assert.equal(both.spot.source, "options");

    const onlyDead = await buildDeribitSnapshot({ legInstruments: ["DEAD-LEG"], primaryInstruments: [], nowMs: NOW });
    assert.equal(onlyDead.underlying, 80480, "протухший спот подменён индексом перпа");
    assert.equal(onlyDead.spot.stale, true);
    assert.equal(onlyDead.spot.source, "index");
    assert.ok(onlyDead.fresh.notes.some((n) => n.includes("спот протух")), "кластер соединения видит подмену");
    assert.equal(onlyDead.fresh.ok, true, "подменённый спот не роняет primary-вердикт");
  } finally {
    global.fetch = real;
  }
});

// ── S2 (OTM-сканер) additive source API: errorStreak surfaces in status() (auto-degradation input),
// setIntervalMs re-arms the timer WITHOUT recreating the source (recreation would zero errorStreak
// and break recovery detection), and the GET-attempt counter feeds the §4.3 budget log. Also proves
// the degradation premise: a failed-perp tick still DELIVERS a snapshot (ts = nowMs), so the
// scanner's tick handler runs - and can detect the streak - even while the exchange is down.
import { createRestSource, getRpcCallCount } from "../src/engine/btcopt/deribit.js";

test("S2 source API: errorStreak in status(); setIntervalMs updates cadence; failing tick still delivers", async () => {
  const real = global.fetch;
  global.fetch = stubFetch("BTC-PERPETUAL"); // перп падает → primary error → errorStreak растёт
  try {
    const src = createRestSource({ intervalMs: 600000, staleAfterSec: 15 }); // интервал заведомо не успеет второй тик
    src.setInstruments([], []); // сканерный режим: primary=[] - гейтит только перп-heartbeat
    assert.equal(src.status().errorStreak, 0, "аддитивное поле присутствует и стартует с нуля");
    assert.equal(src.status().intervalMs, 600000);
    src.setIntervalMs(1200000); // живой перевзвод БЕЗ пересоздания
    assert.equal(src.status().intervalMs, 1200000);
    src.setIntervalMs(NaN); // мусор игнорируется
    assert.equal(src.status().intervalMs, 1200000);

    const c0 = getRpcCallCount();
    let delivered = 0;
    src.start(() => delivered++);
    // Отказ перпа = 2 попытки с retry-снами 1.5с + 3с (rpc backoff) ≈ 4.5с до завершения тика.
    await new Promise((r) => setTimeout(r, 6000));
    src.stop();
    assert.ok(delivered >= 1, "снапшот доставлен несмотря на отказ перпа (ts=nowMs) - деградация детектится в обработчике");
    assert.ok(src.status().errorStreak >= 1, "отказ перпа растит errorStreak");
    assert.equal(src.status().ok, false);
    assert.ok(getRpcCallCount() >= c0 + 2, "счётчик GET считает ПОПЫТКИ (ретраи - реальный трафик)");
  } finally {
    global.fetch = real;
  }
});

test("createRestSource: onError отдаёт ошибку на неудачной попытке и null на выздоровлении", async () => {
  // Инъекция выборки существует только для этого теста: сетевой tick иначе не проверяется.
  let fail = true;
  const src = createRestSource({
    intervalMs: 600000,
    fetchSnapshot: async () => fail
      ? { ts: 1, legs: {}, errors: [{ message: "boom" }], primaryErrors: [{ message: "boom" }],
          fresh: { gateOk: false, gateFailed: [], notes: [] } }
      : { ts: 2, legs: {}, errors: [], primaryErrors: [],
          fresh: { gateOk: true, gateFailed: [], notes: [] } },
  });
  const calls = [];
  src.setOnError((m) => calls.push(m));
  src.start(() => {});
  await new Promise((r) => setTimeout(r, 20));
  fail = false;
  src.refreshNow(); // выздоровление
  await new Promise((r) => setTimeout(r, 20));
  src.stop();
  assert.deepEqual(calls, ["boom", null], "каждая попытка зовёт колбэк: ошибка, затем здоровый null");
  assert.equal(src.status().errorStreak, 0, "здоровая попытка сбросила серию");
});

// ── Комиссии биржи едут в снимок перпа из той же меты, что и размер контракта ──────────────────
test("tickerToPerp: makerFee/takerFee из maker_commission/taker_commission меты; без полей → null, не 0", () => {
  const ticker = { mark_price: 80000, index_price: 79990, best_bid_price: 79999.5, best_ask_price: 80000, funding_8h: 0.0001, current_funding: 0.00005, timestamp: 1788600000000 };
  const meta = { instrument_name: "BTC-PERPETUAL", instrument_type: "reversed", contract_size: 10, tick_size: 0.5, min_trade_amount: 10, maker_commission: 0.00015, taker_commission: 0.00035 };
  const p = tickerToPerp(ticker, meta);
  assert.equal(p.contractSize, 10);
  assert.equal(p.makerFee, 0.00015, "maker биржи");
  assert.equal(p.takerFee, 0.00035, "taker биржи");
  const bare = tickerToPerp(ticker, { instrument_name: "BTC-PERPETUAL", instrument_type: "reversed", contract_size: 10, tick_size: 0.5, min_trade_amount: 10 });
  assert.equal(bare.makerFee, null, "нет поля → null: запасное значение выбирает движок, а не адаптер");
  assert.equal(bare.takerFee, null);
});

test("snapshot: перп композитного снимка несёт ставки комиссий биржи из меты инструмента", async () => {
  const real = global.fetch;
  global.fetch = stubFetch(null);
  try {
    const snap = await buildDeribitSnapshot({ legInstruments: ["PRIM-LEG"], nowMs: 1751500000000 });
    assert.equal(snap.perp.makerFee, 0.00015);
    assert.equal(snap.perp.takerFee, 0.00035);
    assert.equal(snap.perp.contractSize, 10, "размер контракта из той же меты");
  } finally {
    global.fetch = real;
  }
});
