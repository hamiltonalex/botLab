// otmscan-exits.test.js — правила выхода Е1-Е7 (exits.js). Проверяется прежде всего ПОРЯДОК:
// при одновременном срабатывании двух правил отчёт обязан называть одну и ту же причину, иначе
// разбор сделок разъедется между запусками.

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateExit, EXIT_REASONS } from "../src/engine/otmscan/exits.js";

const X = {
  ivDropExitPts: 1.5,
  stopLossPctPrem: 35,
  timeStopH: 12,
  minMoveSigma: 0.1,
  takeProfitPct: 90,
  preExpiryCloseH: 6,
};
// Позиция входа: марк 100, IV 40, час жизни, до экспирации далеко, актив прошёл 1σ.
const base = { entryMarkUsd: 100, entryIvPct: 40, markUsd: 100, ivPct: 40, heldH: 1,
  hoursToExpiry: 500, moveSigma: 1.0, exits: X };

test("ничего не сработало — позиция держится", () => {
  const r = evaluateExit(base);
  assert.equal(r.exit, false);
  assert.equal(r.reason, null);
});

test("Е6 тейк: марк вырос на порог", () => {
  assert.equal(evaluateExit({ ...base, markUsd: 190 }).reason, EXIT_REASONS.TAKE);
  assert.equal(evaluateExit({ ...base, markUsd: 189.9 }).exit, false, "чуть ниже порога — держим");
});

test("Е2 стоп: марк упал на порог", () => {
  assert.equal(evaluateExit({ ...base, markUsd: 65 }).reason, EXIT_REASONS.STOP);
  assert.equal(evaluateExit({ ...base, markUsd: 65.1 }).exit, false);
});

test("Е1 vega-стоп: воля упала на порог", () => {
  assert.equal(evaluateExit({ ...base, ivPct: 38.5 }).reason, EXIT_REASONS.IV_DROP);
  assert.equal(evaluateExit({ ...base, ivPct: 38.6 }).exit, false);
});

test("Е4 тайм-стоп: возраст выше порога И движения нет", () => {
  assert.equal(evaluateExit({ ...base, heldH: 12, moveSigma: 0.05 }).reason, EXIT_REASONS.TIME);
  assert.equal(evaluateExit({ ...base, heldH: 12, moveSigma: 0.5 }).exit, false,
    "движение есть — тайм-стоп не срабатывает");
  assert.equal(evaluateExit({ ...base, heldH: 11.9, moveSigma: 0.05 }).exit, false);
});

test("Е4: неизвестное движение считается отсутствием движения", () => {
  assert.equal(evaluateExit({ ...base, heldH: 12, moveSigma: null }).reason, EXIT_REASONS.TIME);
});

test("Е7 преэкспирация", () => {
  assert.equal(evaluateExit({ ...base, hoursToExpiry: 6 }).reason, EXIT_REASONS.PRE_EXPIRY);
  assert.equal(evaluateExit({ ...base, hoursToExpiry: 6.1 }).exit, false);
});

test("ПОРЯДОК: тейк побеждает стоп, стоп побеждает падение воли, падение воли побеждает тайм-стоп", () => {
  // Марк одновременно и выше тейка, и (гипотетически) ниже стопа быть не может, поэтому порядок
  // проверяется парами, где оба условия выполнимы одновременно.
  assert.equal(evaluateExit({ ...base, markUsd: 65, ivPct: 30 }).reason, EXIT_REASONS.STOP,
    "стоп раньше падения воли");
  assert.equal(evaluateExit({ ...base, ivPct: 30, heldH: 12, moveSigma: 0 }).reason, EXIT_REASONS.IV_DROP,
    "падение воли раньше тайм-стопа");
  assert.equal(evaluateExit({ ...base, heldH: 12, moveSigma: 0, hoursToExpiry: 2 }).reason, EXIT_REASONS.TIME,
    "тайм-стоп раньше преэкспирации");
  assert.equal(evaluateExit({ ...base, markUsd: 190, hoursToExpiry: 2 }).reason, EXIT_REASONS.TAKE,
    "тейк раньше преэкспирации");
});

test("tri-state: без IV правило Е1 просто не срабатывает, а не считается сработавшим", () => {
  assert.equal(evaluateExit({ ...base, ivPct: null }).exit, false);
  assert.equal(evaluateExit({ ...base, entryIvPct: null, ivPct: 1 }).exit, false);
});

test("выключенное правило (порог не положителен) не срабатывает никогда", () => {
  const off = { ...X, stopLossPctPrem: 0 };
  assert.equal(evaluateExit({ ...base, markUsd: 1, exits: off }).exit, false,
    "стоп выключен нулём, марк почти обнулился, выхода нет");
});

test("нет данных о марке или пресете — выхода нет", () => {
  assert.equal(evaluateExit({ ...base, markUsd: null }).exit, false);
  assert.equal(evaluateExit({ ...base, exits: null }).exit, false);
  assert.equal(evaluateExit().exit, false);
});
