// btcopt-stress.test.js — golden what-if stress scenarios (Phase 2d): IV via net_vega·ΔIV, ±10% tail
// pinned to the wing cap (terminal payoff), the instant/terminal hybrid crossover, and funding stress.
// PURE, inline fixtures. Uses the btcopt-engine worked example (net_vega 4.2, net_gamma 0.006, D 777).
import test from "node:test";
import assert from "node:assert/strict";
import { computeScenarios } from "../src/engine/btcopt/stress.js";
import { payoffAt } from "../src/engine/btcopt/payoff.js";

const near = (a, b, tol, l) => assert.ok(Math.abs(a - b) < tol, `${l}: got ${a} want ${b}`);
const S0 = 61000;
// Ноги записаны полностью: терминальная стоимость считается ПО НОГАМ (payoff.js), поэтому заглушка
// «одна нога только ради масштаба» больше не задаёт геометрию. Числа сценариев от этого не меняются:
// у равных ног сумма по ногам тождественна формуле тента.
const leg = (type, side, strike) => ({
  instrument: `${type}-${strike}`, type, side, strike,
  qtyAbs: 1, qtySigned: side === "long" ? 1 : -1, contractSize: 1,
});
const structure = {
  strikes: { atm: 61000, kc: 67000, kp: 55000 },
  entryDebitUsd: 777,
  legs: [leg("call", "long", 61000), leg("put", "long", 61000), leg("call", "short", 67000), leg("put", "short", 55000)],
};
const snapshot = { underlying: S0, index: S0, perp: { contractSize: 10, funding8h: 0.0001 } };
const by = (rows, id) => rows.find((r) => r.id === id);

test("stress: IV shift = net_vega·ΔIV (±25 vol points)", () => {
  const rows = computeScenarios(structure, snapshot, { gamma: 0.006, vega: 4.2 }, { qty: 0 }, {});
  near(by(rows, "iv_up").pnlUsd, 105, 1e-9, "iv_up = 4.2·25");
  near(by(rows, "iv_crush").pnlUsd, -105, 1e-9, "iv_crush = 4.2·(−25)");
  assert.equal(by(rows, "iv_up").mode, "instant");
});

test("stress: ±10% tail pins to the wing cap (terminal payoff, mode expiry)", () => {
  const rows = computeScenarios(structure, snapshot, { gamma: 0.006, vega: 4.2 }, { qty: 0 }, {});
  const up = by(rows, "tail_up");
  near(up.pnlUsd, payoffAt(structure, S0 * 1.1) - payoffAt(structure, S0), 1e-9, "tail = terminal gain");
  near(up.pnlUsd, 6000, 1e-9, "wing cap = unit·6000 (67100 beyond Kc=67000)");
  assert.equal(up.mode, "expiry");
});

test("stress: small gamma → ±5% uses the instant convexity estimate (mode instant)", () => {
  const rows = computeScenarios(structure, snapshot, { gamma: 1e-7, vega: 4.2 }, { qty: 0 }, {});
  const t = by(rows, "trend_up"), dS = S0 * 0.05;
  near(t.pnlUsd, 0.5 * 1e-7 * dS * dS, 1e-9, "instant gamma ½·Γ·ΔS²");
  assert.equal(t.mode, "instant");
});

test("stress: large gamma → ±5% is bounded by the terminal payoff (never exceeds the wing cap)", () => {
  const rows = computeScenarios(structure, snapshot, { gamma: 0.006, vega: 4.2 }, { qty: 0 }, {});
  const t = by(rows, "trend_up");
  near(t.pnlUsd, payoffAt(structure, S0 * 1.05) - payoffAt(structure, S0), 1e-9, "bounded to terminal gain 3050");
  assert.ok(t.pnlUsd < 0.5 * 0.006 * Math.pow(S0 * 0.05, 2), "tighter than the raw instant-gamma estimate");
  assert.equal(t.mode, "expiry");
});

test("stress: funding stress = −qty·cs·(3·funding8h)·(H/8h), short receives", () => {
  const rows = computeScenarios(structure, snapshot, { gamma: 0.006, vega: 4.2 }, { qty: -13 }, { fundingHorizonSec: 28800 });
  const f = by(rows, "funding_stress");
  near(f.pnlUsd, -(-13) * 10 * (3 * 0.0001) * 1, 1e-9, "short −13 receives 3× funding over one window");
  assert.ok(f.pnlUsd > 0, "short receives positive funding");
  assert.equal(f.mode, "horizon");
});

test("stress: flat is zero; no structure → empty list", () => {
  const rows = computeScenarios(structure, snapshot, { gamma: 0.006, vega: 4.2 }, { qty: 0 }, {});
  near(by(rows, "flat").pnlUsd, 0, 1e-9, "flat = 0");
  assert.deepEqual(computeScenarios(null, snapshot, {}, {}, {}), []);
});

// ── ОБЕ КЛЕТКИ СПОТОВОГО РЯДА СТОЯТ НА ХЕДЖИРОВАННОЙ БАЗЕ.
// Регресс к находке аудита: у структуры с КОРОТКОЙ гаммой (схема продавца) терминальная ветка
// считалась по одному опциону, то есть БЕЗ хеджа, а гамма-оценка - при хедже. Правило min(...)
// сравнивало два числа в разных системах отсчёта, и таблица врала в обе стороны сразу.
test("стресс: терминальная ветка учитывает держимый перп (короткий колл с хеджем)", () => {
  const expiry = Date.UTC(2026, 0, 21, 8, 0, 0);
  const structure = {
    expiryMs: expiry, kind: "sell-call", strikes: { atm: 100000 },
    legs: [{ instrument: "C", type: "call", side: "short", strike: 100000,
      qtyAbs: 1, qtySigned: -1, contractSize: 1, entryMark: 3000 }],
    entryDebitUsd: -3000,
  };
  const snapshot = { underlying: 100000, index: 100000, perp: { mark: 100000, funding8h: 0, contractSize: 10 } };
  const greeks = { gamma: -0.00002, vega: -120, theta: 5 };
  // Хедж короткого колла это ЛОНГ перпа: 4500 контрактов по $10 со средним входом 100000 дают
  // долларовую дельту 4500·10/100000 = 0.45 BTC - ровно дельту проданной ноги.
  const hedged = computeScenarios(structure, snapshot, greeks, { qty: 4500, avgEntry: 100000 }, {});
  const flat = computeScenarios(structure, snapshot, greeks, { qty: 0, avgEntry: 0 }, {});
  const up = (rows) => rows.find((r) => r.id === "tail_up").pnlUsd;

  // Без хеджа верхний хвост это чистый убыток короткого колла на движении вверх.
  assert.ok(up(flat) < -5000, `нехеджированный верхний хвост должен быть большим убытком: ${up(flat)}`);
  // С хеджем убыток КРАТНО меньше: перп зарабатывает на том же движении.
  // Разница между ветками равна ВКЛАДУ ПЕРПА на том же движении, и это точное число, а не
  // «стало получше»: долларовая дельта 0.45 на движении +$10 000 даёт ровно +$4 500.
  // Остаток −5 500 это честная гамма-потеря статически хеджированного короткого колла на скачке:
  // дельта опциона по дороге растёт к единице, а хедж стоит на месте.
  assert.ok(Math.abs((up(hedged) - up(flat)) - 4500) < 1e-6,
    `вклад перпа должен быть ровно +4500: ${up(hedged) - up(flat)}`);
});
