// btcopt-hedge.test.js - golden worked-examples for the «BTC-опционы» delta-hedge engine.
// PURE math, inline crafted inputs (no fixtures). Reproduces the spec's worked numbers exactly.
// All time-dependent calls pass an explicit nowMs (never Date.now()) so the tests are deterministic.
import test from "node:test";
import assert from "node:assert/strict";
import {
  roundToStep,
  settlementBlackout,
  computeTriggers,
  expectedBenefit,
  estimateCost,
  decideHedge,
  applyFill,
  perpFeeRate,
  contractsForDelta,
  effectiveDeadband,
  benefitMoveFrac,
  DEADBAND_REF_QTY,
} from "../src/engine/btcopt/hedge.js";
import { markPerp } from "../src/engine/btcopt/pnl.js";

const near = (a, b, tol, label) =>
  assert.ok(Math.abs(a - b) <= tol, `${label}: got ${a}, want ${b} (+/-${tol})`);

// Base config shared by the HEDGE / SKIP / BLACKOUT worked examples.
const baseCfg = {
  deadbandBtc: 0,
  lambda: 1.25,
  priceTriggerPct: 0.5,
  takerFeeRate: 0.0005,
  slippageRate: 0,
  fundingHorizonSec: 28800,
  settlementBlackout: true,
  execStyle: "limit",
  rehedgeSec: 60,
  dailyWindowSec: 600,
  preExpirySec: 1800,
};

const NOON = Date.UTC(2026, 6, 10, 12, 0, 0); // not a blackout window
const EXPIRY_FAR = Date.UTC(2026, 6, 20, 8, 0, 0); // 10 days out
const SETTLE_0800 = Date.UTC(2026, 6, 10, 8, 0, 0); // daily settlement

test("roundToStep rounds to the exchange step (sign preserved)", () => {
  near(roundToStep(0.00123, 0.0005), 0.001, 1e-12, "0.00123→0.001");
  near(roundToStep(0.0013, 0.0005), 0.0015, 1e-12, "0.0013→0.0015");
  near(roundToStep(-0.0026, 0.001), -0.003, 1e-12, "-0.0026→-0.003");
  assert.equal(roundToStep(0.0042, 0), 0.0042, "step<=0 is a pass-through");
});

test("settlementBlackout: daily 08:00 window is active", () => {
  const r = settlementBlackout(SETTLE_0800, EXPIRY_FAR, baseCfg);
  assert.equal(r.active, true);
  assert.equal(r.reason, "settlement-0800");
});

test("settlementBlackout: 20 min past 08:00 is inactive", () => {
  const r = settlementBlackout(Date.UTC(2026, 6, 10, 8, 20, 0), EXPIRY_FAR, baseCfg);
  assert.equal(r.active, false);
  assert.equal(r.reason, null);
});

test("settlementBlackout: within preExpirySec (outside daily window) is pre-expiry", () => {
  const expiry = Date.UTC(2026, 6, 10, 8, 0, 0);
  const now = Date.UTC(2026, 6, 10, 7, 40, 0); // 20 min before expiry
  const r = settlementBlackout(now, expiry, baseCfg);
  assert.equal(r.active, true);
  assert.equal(r.reason, "pre-expiry");
});

test("settlementBlackout: mid-session (04:00) is inactive", () => {
  const r = settlementBlackout(Date.UTC(2026, 6, 10, 4, 0, 0), EXPIRY_FAR, baseCfg);
  assert.equal(r.active, false);
  assert.equal(r.reason, null);
});

test("computeTriggers: delta-only fires with the excess and reasons list", () => {
  const t = computeTriggers({
    totalDelta: -0.002,
    deadband: 0,
    underlying: 63000,
    lastHedgeUnderlying: null,
    priceTriggerPct: 0.5,
    nowMs: NOON,
    lastHedgeAt: null,
    rehedgeMs: 60000,
    createdAt: null,
  });
  near(t.deltaExcess, 0.002, 1e-12, "deltaExcess");
  assert.equal(t.deltaFired, true);
  assert.equal(t.priceFired, false);
  assert.equal(t.timeFired, false);
  assert.deepEqual(t.reasons, ["delta"]);
});

test("expectedBenefit = |deltaBtc|·underlying·m", () => {
  near(expectedBenefit({ deltaBtc: 0.002, underlying: 63000, m: 0.005 }), 0.63, 1e-9, "benefit");
});

// The golden worked numbers (taker fee + half-spread) are MARKET-branch semantics.
const mktCfg = { ...baseCfg, execStyle: "market" };

test("estimateCost (market) itemizes fee/spread/slippage/funding and sums total", () => {
  const c = estimateCost({
    hedgeQty: 0.002,
    targetQty: 0.002,
    perp: { mark: 63000, funding8h: 0, contractSize: 10 },
    liquidity: { halfSpread: 1 },
    cfg: mktCfg,
  });
  near(c.fee, 0.126, 1e-9, "fee");
  near(c.spread, 0.002, 1e-9, "spread");
  near(c.slippage, 0, 1e-9, "slippage");
  near(c.funding_horizon, 0, 1e-9, "funding_horizon");
  near(c.total, 0.128, 1e-9, "total");
});

test("estimateCost (limit): maker fee, no spread term, slippage survives as the cost floor", () => {
  const c = estimateCost({
    hedgeQty: 0.002,
    targetQty: 0.002,
    perp: { mark: 63000, funding8h: 0, contractSize: 10 },
    liquidity: { halfSpread: 1 },
    cfg: { ...baseCfg, slippageRate: 0.0002 }, // execStyle "limit" from baseCfg
  });
  near(c.fee, 0, 1e-12, "fee (снимок без ставки биржи, cfg без makerFeeRate → 0)");
  near(c.spread, 0, 1e-12, "spread (mid fill crosses nothing)");
  near(c.slippage, 0.002 * 63000 * 0.0002, 1e-9, "slippage (kept in both branches)");
  near(c.total, c.slippage, 1e-9, "total = slippage only");
});

test("estimateCost: фандинг берётся с ПРИРАЩЕНИЯ заявки, карри всей позиции отдельной статьёй", () => {
  // ЧТО ЗДЕСЬ ЗАКРЕПЛЕНО. Маргинальная цена перекладки это то, что заявка ДОБАВЛЯЕТ, а карри всей
  // позиции платится независимо от решения переложиться. Прежде в total шёл targetQty, и полоса
  // становилась плавающей: при ставке +5 б.п./8ч движок ждал троекратной полосы вместо своей.
  const c = estimateCost({
    hedgeQty: 0.002,
    targetQty: -0.01,
    perp: { mark: 63000, funding8h: 0.0002, contractSize: 10 },
    liquidity: { halfSpread: 1 },
    cfg: mktCfg,
  });
  near(c.funding_horizon, 0.002 * 63000 * 0.0002, 1e-9, "фандинг на приращении");
  near(c.carry_horizon, -0.01 * 63000 * 0.0002, 1e-9, "карри целевой позиции виден отдельно");
  near(c.total, c.fee + c.spread + c.slippage + c.funding_horizon, 1e-9, "карри в total НЕ входит");
  // Знак сохранён: заявка, СНИМАЮЩАЯ лонг при положительной ставке, экономит карри.
  const sell = estimateCost({
    hedgeQty: -0.002,
    targetQty: 0.01,
    perp: { mark: 63000, funding8h: 0.0002, contractSize: 10 },
    liquidity: { halfSpread: 1 },
    cfg: mktCfg,
  });
  near(sell.funding_horizon, -0.002 * 63000 * 0.0002, 1e-9, "знак приращения сохранён");
});

test("decideHedge: отрицательные издержки не вырождают гейт (сравнение с max(0, total))", () => {
  // При благоприятной ставке фандинга total может уйти в минус, и тогда `benefit > total·λ`
  // выполнялось бы при ЛЮБОЙ выгоде. Здесь избыток дельты РОВНО ноль: заявки быть не должно.
  const r = decideHedge({
    optionDelta: -0.001, Qperp: 0.001, // ровно нейтрально: избытка нет
    snapshot: { underlying: 63000, perp: { mark: 63000, funding8h: -0.01, contractSize: 10 } },
    liquidity: { halfSpread: 1 },
    cfg: { ...mktCfg, deadbandBtc: 0.001, deadbandRefQty: 0.01, lambda: 1.25, priceTriggerPct: 0,
      rehedgeSec: 0, settlementBlackout: false, benefitMovePct: 0.5 },
    nowMs: NOON, expiryMs: NOON + 86400000, createdAt: NOON - 1000,
    lastHedgeAt: null, lastHedgeUnderlying: null, step: 10 / 63000, structureQty: 0.01,
  });
  assert.equal(r.decision, "SKIP", "нулевой избыток не может пройти гейт ни при какой ставке");
});

test("decideHedge HEDGE case - benefit clears cost·lambda", () => {
  const r = decideHedge({
    optionDelta: -0.002,
    Qperp: 0,
    snapshot: { underlying: 63000, perp: { mark: 63000, funding8h: 0, contractSize: 10 } },
    liquidity: { bid: 62999, ask: 63001, halfSpread: 1 },
    cfg: mktCfg,
    nowMs: NOON,
    expiryMs: EXPIRY_FAR,
    createdAt: null,
    lastHedgeAt: null,
    lastHedgeUnderlying: null,
    step: 0.0005,
  });
  assert.equal(r.decision, "HEDGE");
  near(r.delta_excess, 0.002, 1e-9, "delta_excess");
  near(r.estimated_benefit, 0.63, 1e-9, "estimated_benefit");
  near(r.estimated_cost.fee, 0.126, 1e-9, "estimated_cost.fee");
  near(r.estimated_cost.total, 0.128, 1e-9, "estimated_cost.total");
  assert.equal(r.hedge_order.side, "buy");
  near(r.hedge_order.amount_rounded_btc, 0.002, 1e-9, "amount_rounded_btc");
  near(r.target_futures_delta, 0.002, 1e-9, "target_futures_delta");
  assert.equal(r.hedge_order.order_type, "market");
  assert.equal(r.hedge_order.post_only, false);
  assert.deepEqual(r.trigger_reason, ["delta"]);
});

test("decideHedge (limit) - the order rides post-only and the cost model follows the branch", () => {
  const r = decideHedge({
    optionDelta: -0.002,
    Qperp: 0,
    snapshot: { underlying: 63000, perp: { mark: 63000, funding8h: 0, contractSize: 10 } },
    liquidity: { bid: 62999, ask: 63001, halfSpread: 1 },
    cfg: baseCfg, // execStyle "limit"
    nowMs: NOON,
    expiryMs: EXPIRY_FAR,
    createdAt: null,
    lastHedgeAt: null,
    lastHedgeUnderlying: null,
    step: 0.0005,
  });
  assert.equal(r.decision, "HEDGE");
  assert.equal(r.hedge_order.order_type, "limit");
  assert.equal(r.hedge_order.post_only, true);
  near(r.estimated_cost.fee, 0, 1e-12, "fee (maker)");
  near(r.estimated_cost.spread, 0, 1e-12, "spread (mid fill)");
});

test("decideHedge SKIP case - cost filter blocks the hedge", () => {
  const r = decideHedge({
    optionDelta: -0.0005,
    Qperp: 0,
    snapshot: { underlying: 63000, perp: { mark: 63000, funding8h: 0, contractSize: 10 } },
    liquidity: { bid: 62870, ask: 63130, halfSpread: 130 },
    cfg: { ...mktCfg, slippageRate: 0.001 },
    nowMs: NOON,
    expiryMs: EXPIRY_FAR,
    createdAt: null,
    lastHedgeAt: null,
    lastHedgeUnderlying: null,
    step: 0.0005,
  });
  assert.equal(r.decision, "SKIP");
  near(r.estimated_benefit, 0.1575, 1e-9, "estimated_benefit");
  near(r.estimated_cost.fee, 0.0315, 1e-9, "fee");
  near(r.estimated_cost.spread, 0.065, 1e-9, "spread");
  near(r.estimated_cost.slippage, 0.0315, 1e-9, "slippage");
  near(r.estimated_cost.total, 0.128, 1e-9, "total");
  assert.equal(r.hedge_order, null);
  // gate: 0.1575 > 0.128·1.25 = 0.16 is false
  assert.equal(r.estimated_benefit > r.estimated_cost.total * 1.25, false);
});

test("decideHedge BLACKOUT case - settlement window suppresses the hedge", () => {
  const r = decideHedge({
    optionDelta: -0.002,
    Qperp: 0,
    snapshot: { underlying: 63000, perp: { mark: 63000, funding8h: 0, contractSize: 10 } },
    liquidity: { bid: 62999, ask: 63001, halfSpread: 1 },
    cfg: baseCfg,
    nowMs: SETTLE_0800,
    expiryMs: EXPIRY_FAR,
    createdAt: null,
    lastHedgeAt: null,
    lastHedgeUnderlying: null,
    step: 0.0005,
  });
  assert.equal(r.decision, "BLACKOUT");
  assert.equal(r.hedge_order, null);
  assert.equal(r.blackout.active, true);
  assert.equal(r.blackout.reason, "settlement-0800");
  near(r.delta_excess, 0.002, 1e-9, "delta_excess");
});

test("applyFill inverse: open short then close for realized USD", () => {
  const perpState = { qty: 0, avgEntry: 0, feesCum: 0, realizedUsd: 0 };
  const meta = { contractSize: 10 };
  const cfg = { takerFeeRate: 0.0005 };

  // open short 0.002 BTC @ 63000 → round(-12.6) = -13 contracts
  const open = applyFill(perpState, { side: "sell", amount_rounded_btc: 0.002 }, 63000, meta, cfg);
  assert.equal(open.filledContracts, -13);
  assert.equal(perpState.qty, -13);
  near(perpState.avgEntry, 63000, 1e-9, "avgEntry after open");
  near(open.feeUsd, 0.065, 1e-9, "feeUsd open");
  near(open.realizedUsd, 0, 1e-9, "realizedUsd open");

  // ЧАСТИЧНОЕ ПОКРЫТИЕ. Заявка выражена в ДЕЛЬТЕ, а закрываемые контракты несут базис ПОЗИЦИИ
  // (63000), а не цену сделки (60000): 0.001·63000/10 = 6.3 → 6 контрактов. Пересчёт по цене
  // сделки дал бы 6 контрактов из 0.001·60000/10 = 6.0 и снял бы НЕ ТУ дельту (см. contractsForDelta).
  const close = applyFill(perpState, { side: "buy", amount_rounded_btc: 0.001 }, 60000, meta, cfg);
  assert.equal(close.filledContracts, 6);
  assert.equal(perpState.qty, -7);
  near(perpState.avgEntry, 63000, 1e-9, "avgEntry after partial close");
  near(close.realizedUsd, (6 * 10 * 3000) / 63000, 1e-9, "realizedUsd close"); // +2.857
  near(perpState.realizedUsd, (6 * 10 * 3000) / 63000, 1e-9, "cumulative realizedUsd");
});

// РЕГРЕСС: пересчёт дельты в контракты обязан быть точным в обе стороны, иначе хедж мажет мимо
// собственной цели тем сильнее, чем дальше цена ушла от среднего входа.
test("contractsForDelta: добавление по цене сделки, уменьшение по базису позиции, переворот через ноль", () => {
  const cs = 10;
  const flat = { qty: 0, avgEntry: 0 };
  near(contractsForDelta(flat, 0.002, 60000, cs), 12, 1e-9, "с нуля, по цене сделки");

  const long = { qty: 2000, avgEntry: 50000 }; // дельта = 2000·10/50000 = 0.4
  near((long.qty * cs) / long.avgEntry, 0.4, 1e-12, "исходная дельта");
  near(contractsForDelta(long, 0.05, 60000, cs), (0.05 * 60000) / cs, 1e-9, "добавление, по 60000");
  // уменьшение: контракты несут базис 50000, поэтому −0.05 дельты это −250 контрактов, не −300
  near(contractsForDelta(long, -0.05, 60000, cs), -250, 1e-9, "уменьшение, по базису");
  // и снятая дельта равна ЗАПРОШЕННОЙ
  near((-250 * cs) / long.avgEntry, -0.05, 1e-12, "снятая дельта равна запросу");
  // переворот: закрыть все 2000 (снимает 0.4), остаток −0.1 открыть по 60000 ⇒ −2000 − 600
  near(contractsForDelta(long, -0.5, 60000, cs), -2000 - 600, 1e-9, "переворот через ноль");
});

test("закрытие позиции в ноль снимает ВСЮ дельту, а не qty·avgEntry/mark", () => {
  const cs = 10;
  const perpState = { qty: 2000, avgEntry: 50000, feesCum: 0, realizedUsd: 0 };
  const held = (perpState.qty * cs) / perpState.avgEntry; // 0.4
  applyFill(perpState, { side: "sell", amount_rounded_btc: held, order_type: "market" }, 60000,
    { contractSize: cs }, { takerFeeRate: 0 });
  assert.equal(perpState.qty, 0, "позиция закрыта целиком, хвоста не осталось");
  assert.equal(perpState.avgEntry, 0);
});

// ── Средний вход обратного контракта (fix 2026-08-13, найдено прогоном записи) ───────────────────
// Позиция, набранная по РАЗНЫМ ценам: дельта и P&L обязаны равняться сумме по лотам, а не считаться
// от арифметического среднего входа (оно занижает и то, и другое; равенство только при P₁ = P₂).
test("applyFill: средний вход набирается по 1/P, дельта равна Σqᵢ·cs/Pᵢ", () => {
  const cs = 10;
  const perpState = { qty: 0, avgEntry: 0, feesCum: 0, realizedUsd: 0 };
  const cfg = { makerFeeRate: 0, takerFeeRate: 0 };
  const buy = (btc, P) =>
    applyFill(perpState, { side: "buy", amount_rounded_btc: btc, order_type: "limit" }, P, { contractSize: cs }, cfg);

  const f1 = buy(0.45, 47000);
  const f2 = buy(0.03, 48000);
  const f3 = buy(0.02, 51500);
  const lots = [[f1.filledContracts, 47000], [f2.filledContracts, 48000], [f3.filledContracts, 51500]];
  const trueDelta = lots.reduce((s, [q, P]) => s + (q * cs) / P, 0);
  near((perpState.qty * cs) / perpState.avgEntry, trueDelta, 1e-12, "дельта от avgEntry = сумма по лотам");

  const M = 60000;
  const truePnl = lots.reduce((s, [q, P]) => s + (q * cs * (M - P)) / P, 0);
  const booked = markPerp(perpState, { mark: M, contractSize: cs }).upl_usd;
  near(booked, truePnl, 1e-9, "P&L от avgEntry = сумма по лотам");
});

test("хедж попадает в СОБСТВЕННУЮ цель: после заливки невязки дельта равна нужной", () => {
  const cs = 10;
  const perpState = { qty: 0, avgEntry: 0, feesCum: 0, realizedUsd: 0 };
  const cfg = { makerFeeRate: 0, takerFeeRate: 0 };
  const delta = () => (perpState.qty === 0 ? 0 : (perpState.qty * cs) / perpState.avgEntry);
  const hedgeTo = (want, P) => {
    const raw = want - delta();
    applyFill(perpState, { side: raw > 0 ? "buy" : "sell", amount_rounded_btc: Math.abs(raw), order_type: "limit" },
      P, { contractSize: cs }, cfg);
  };
  // цена растёт, цель растёт: промах не имеет права КОПИТЬСЯ от перекладки к перекладке
  hedgeTo(0.45, 47000);
  for (let i = 1; i <= 10; i++) hedgeTo(0.45 + i * 0.01, 47000 + i * 1000);
  near(delta(), 0.55, 1e-9, "дельта после десяти перекладок равна цели");
});

// ── Полоса против размера позиции (fix 2026-08-13, Д3) ───────────────────────────────────────────
test("effectiveDeadband: на калибровочном размере равна настройке, дальше растёт линейно", () => {
  const db = 0.001;
  near(effectiveDeadband({ deadbandBtc: db, structureQty: 0.01, refQty: 0.01 }), db, 1e-15, "1x");
  near(effectiveDeadband({ deadbandBtc: db, structureQty: 0.05, refQty: 0.01 }), db * 5, 1e-15, "5x");
  near(effectiveDeadband({ deadbandBtc: db, structureQty: 1, refQty: 0.01 }), db * 100, 1e-12, "100x");
  // ОТНОСИТЕЛЬНАЯ теснота полосы и есть инвариант, ради которого правка делалась.
  const rel = (q) => effectiveDeadband({ deadbandBtc: db, structureQty: q, refQty: 0.01 }) / q;
  near(rel(0.01), rel(0.37), 1e-15, "полоса на единицу размера не зависит от размера");
});

test("effectiveDeadband: размер неизвестен - берётся сырая настройка, а не догадка", () => {
  const db = 0.002;
  near(effectiveDeadband({ deadbandBtc: db }), db, 1e-15, "нет размера");
  near(effectiveDeadband({ deadbandBtc: db, structureQty: 0 }), db, 1e-15, "нулевой размер");
  near(effectiveDeadband({ deadbandBtc: db, structureQty: 0.05, refQty: 0 }), db, 1e-15, "нулевой якорь");
  assert.equal(effectiveDeadband({}), 0, "нет настройки - нет полосы");
  assert.equal(DEADBAND_REF_QTY, 0.01, "якорь по умолчанию равен дефолтному размеру движка");
});

test("decideHedge: на впятеро большей структуре полоса впятеро шире", () => {
  const cfg = { ...baseCfg, deadbandBtc: 0.001, deadbandRefQty: 0.01, settlementBlackout: false };
  const args = (structureQty) => ({
    optionDelta: -0.004, Qperp: 0, snapshot: { underlying: 60000, perp: { mark: 60000, funding8h: 0 } },
    liquidity: { halfSpread: 0 }, cfg, nowMs: NOON, expiryMs: EXPIRY_FAR, createdAt: NOON,
    lastHedgeAt: NOON, lastHedgeUnderlying: 60000, step: 0, structureQty,
  });
  const small = decideHedge(args(0.01));
  const big = decideHedge(args(0.05));
  near(small.deadband_btc, 0.001, 1e-15, "полоса на калибровочном размере");
  near(big.deadband_btc, 0.005, 1e-15, "полоса на впятеро большем размере");
  // Один и тот же перекос дельты: у малой структуры он ЗА полосой, у большой внутри.
  assert.deepEqual(small.trigger_reason, ["delta"]);
  assert.deepEqual(big.trigger_reason, [], "тот же перекос на большем размере триггер не взводит");
  near(small.delta_excess, 0.003, 1e-15);
  assert.equal(big.delta_excess, 0);
});

// ── Масштаб выгоды отдельно от ценового триггера (fix 2026-08-13, Д2) ────────────────────────────
test("benefitMoveFrac: свой knob, с откатом на priceTriggerPct у старых профилей", () => {
  near(benefitMoveFrac({ benefitMovePct: 2, priceTriggerPct: 0.5 }), 0.02, 1e-15, "свой knob выигрывает");
  near(benefitMoveFrac({ priceTriggerPct: 0.5 }), 0.005, 1e-15, "старый профиль сохраняет поведение");
  assert.equal(benefitMoveFrac({}), 0, "нет ни того, ни другого - выгода нулевая");
});

test("масштаб выгоды теперь настраивается, НЕ взводя ценовой триггер", () => {
  // Ровно то, что было невозможно до правки: один knob менял и порог триггера, и масштаб выгоды.
  const base = { ...baseCfg, deadbandBtc: 0.001, deadbandRefQty: 0.01, settlementBlackout: false,
    priceTriggerPct: 0.5, slippageRate: 0.0002 };
  const args = (cfg) => ({
    optionDelta: -0.0015, Qperp: 0, snapshot: { underlying: 60000, perp: { mark: 60000, funding8h: 0 } },
    liquidity: { halfSpread: 0 }, cfg, nowMs: NOON, expiryMs: EXPIRY_FAR, createdAt: NOON,
    lastHedgeAt: NOON, lastHedgeUnderlying: 60000, step: 0, structureQty: 0.01,
  });
  const stingy = decideHedge(args({ ...base, benefitMovePct: 0.01 }));
  const generous = decideHedge(args({ ...base, benefitMovePct: 5 }));
  assert.equal(stingy.decision, "SKIP", "мелкая ожидаемая выгода не окупает перекладку");
  assert.equal(generous.decision, "HEDGE", "крупная окупает");
  // Ценовой триггер при этом НЕ участвовал ни в одном из двух прогонов.
  for (const d of [stingy, generous]) assert.ok(!d.trigger_reason.includes("price"), "триггер цены молчит");
  assert.ok(generous.estimated_benefit > stingy.estimated_benefit, "менялась именно выгода");
});

// ── Ставка комиссии перпа: снимок биржи первым, cfg запасным ─────────────────────────────────────
// Повод: до 2026-09-05 ставки жили константами движка (maker 0 / taker 0.0005), и бумажный прогон
// 17.08-05.09 книжил 87 исполнений хеджа по нулю при бирже 0.00015 / 0.00035 (недобрано $32.83).
test("perpFeeRate: ставка из снимка перпа побеждает cfg; без поля в снимке берётся cfg; ноль биржи законен", () => {
  const cfg = { makerFeeRate: 0, takerFeeRate: 0.0005 };
  const live = { makerFee: 0.00015, takerFee: 0.00035 };
  near(perpFeeRate(live, cfg, "limit"), 0.00015, 1e-15, "maker из снимка");
  near(perpFeeRate(live, cfg, "market"), 0.00035, 1e-15, "taker из снимка");
  near(perpFeeRate({ mark: 63000, contractSize: 10 }, cfg, "limit"), 0, 1e-15, "без поля: cfg.makerFeeRate");
  near(perpFeeRate({ mark: 63000, contractSize: 10 }, cfg, "market"), 0.0005, 1e-15, "без поля: cfg.takerFeeRate");
  near(perpFeeRate({ makerFee: null, takerFee: null }, cfg, "market"), 0.0005, 1e-15, "null это отсутствие, не ноль");
  near(perpFeeRate({ makerFee: 0, takerFee: 0 }, { makerFeeRate: 0.001, takerFeeRate: 0.001 }, "limit"), 0, 1e-15, "ноль от биржи берётся как есть");
  near(perpFeeRate(null, cfg, "limit"), 0, 1e-15, "перп null → cfg");
});

test("estimateCost: комиссия по ставке снимка перпа (2x за круг), cfg не решает", () => {
  const perp = { mark: 63000, funding8h: 0, contractSize: 10, makerFee: 0.00015, takerFee: 0.00035 };
  const lim = estimateCost({ hedgeQty: 0.002, targetQty: 0.002, perp, liquidity: { halfSpread: 1 }, cfg: baseCfg });
  near(lim.fee, 2 * 0.002 * 63000 * 0.00015, 1e-12, "limit: maker биржи, хотя в cfg makerFeeRate нет");
  const mkt = estimateCost({ hedgeQty: 0.002, targetQty: 0.002, perp, liquidity: { halfSpread: 1 }, cfg: mktCfg });
  near(mkt.fee, 2 * 0.002 * 63000 * 0.00035, 1e-12, "market: taker биржи вместо cfg 0.0005");
  near(mkt.total, mkt.fee + 0.002, 1e-12, "спред тот же, проскальзывание и фандинг нулевые");
});

test("applyFill: комиссия исполнения по ставке снимка перпа; снимок без ставки → cfg", () => {
  const cfg = { makerFeeRate: 0, takerFeeRate: 0.0005 };
  const live = { contractSize: 10, makerFee: 0.00015, takerFee: 0.00035 };
  const ps1 = { qty: 0, avgEntry: 0, feesCum: 0, realizedUsd: 0 };
  const f1 = applyFill(ps1, { side: "sell", amount_rounded_btc: 0.002, order_type: "limit" }, 63000, live, cfg);
  assert.equal(f1.filledContracts, -13);
  near(f1.feeUsd, 13 * 10 * 0.00015, 1e-12, "limit → maker биржи 0.015%");
  const ps2 = { qty: 0, avgEntry: 0, feesCum: 0, realizedUsd: 0 };
  const f2 = applyFill(ps2, { side: "sell", amount_rounded_btc: 0.002, order_type: "market" }, 63000, live, cfg);
  near(f2.feeUsd, 13 * 10 * 0.00035, 1e-12, "market → taker биржи 0.035%");
  near(ps2.feesCum, f2.feeUsd, 1e-12, "накопитель комиссий получил ту же сумму");
  const ps3 = { qty: 0, avgEntry: 0, feesCum: 0, realizedUsd: 0 };
  const f3 = applyFill(ps3, { side: "sell", amount_rounded_btc: 0.002, order_type: "market" }, 63000, { contractSize: 10 }, cfg);
  near(f3.feeUsd, 13 * 10 * 0.0005, 1e-12, "без ставки в снимке → cfg.takerFeeRate");
});
