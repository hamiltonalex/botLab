// fa-drawdown.test.js - СТОРОЖ ПРОСАДКИ (fa/drawdown.js): порог в кругах, включительность, неизвестные
// числа леджера, выключение параметром, реестр из одного кода.

import test from "node:test";
import assert from "node:assert/strict";
import { FA_DRAWDOWN_DEFAULTS, FA_DRAWDOWN_REFUSALS, drawdownGuard, explainDrawdown } from "../src/engine/fa/drawdown.js";

test("умолчание это два круга, замер З6; реестр из одного кода", () => {
  assert.equal(FA_DRAWDOWN_DEFAULTS.drawdownStopRounds, 2);
  assert.deepEqual([...FA_DRAWDOWN_REFUSALS], ["drawdown_stop"]);
  assert.ok(Object.isFrozen(FA_DRAWDOWN_DEFAULTS) && Object.isFrozen(FA_DRAWDOWN_REFUSALS));
});

test("просадка ниже порога это порядок, на пороге и выше это стоп (порог ВКЛЮЧИТЕЛЬНО, как в стенде)", () => {
  const ok = drawdownGuard({ cumUsd: 10, peakUsd: 25, roundTripUsd: 9 }); // 15 < 18
  assert.equal(ok.enabled, true);
  assert.equal(ok.known, true);
  assert.equal(ok.ok, true);
  assert.equal(ok.code, null);
  assert.equal(ok.drawdownUsd, 15);
  assert.equal(ok.thresholdUsd, 18);
  const edge = drawdownGuard({ cumUsd: 7, peakUsd: 25, roundTripUsd: 9 }); // ровно 18
  assert.equal(edge.ok, false);
  assert.equal(edge.code, "drawdown_stop");
  const deep = drawdownGuard({ cumUsd: -30, peakUsd: 2, roundTripUsd: 9 }); // сделка ушла в минус
  assert.equal(deep.code, "drawdown_stop");
  assert.equal(deep.drawdownUsd, 32);
});

test("пик не ниже накопленного по построению леджера; чужая запись с пиком ниже читается как нулевая просадка", () => {
  const v = drawdownGuard({ cumUsd: 30, peakUsd: 25, roundTripUsd: 9 });
  assert.equal(v.drawdownUsd, 0);
  assert.equal(v.ok, true);
});

test("неизвестные числа леджера стоп НЕ зовут: это отказ снабжения, а не просадка", () => {
  for (const bad of [
    { cumUsd: null, peakUsd: 25, roundTripUsd: 9 },
    { cumUsd: 5, peakUsd: undefined, roundTripUsd: 9 },
    { cumUsd: 5, peakUsd: 25, roundTripUsd: 0 },
    { cumUsd: 5, peakUsd: 25, roundTripUsd: NaN },
    {},
  ]) {
    const v = drawdownGuard(bad);
    assert.equal(v.enabled, true);
    assert.equal(v.known, false, JSON.stringify(bad));
    assert.equal(v.ok, true);
    assert.equal(v.code, null);
  }
});

test("ноль, пусто и отрицательное значение параметра ВЫКЛЮЧАЮТ сторож, а НЕ переданный параметр это умолчание", () => {
  assert.equal(drawdownGuard({ cumUsd: 0, peakUsd: 20, roundTripUsd: 9 }).rounds, 2, "параметр не передан: два круга");
  for (const rounds of [0, null, -1, "x", ""]) {
    const v = drawdownGuard({ cumUsd: -100, peakUsd: 100, roundTripUsd: 9, rounds });
    assert.equal(v.enabled, false, String(rounds));
    assert.equal(v.code, null);
    assert.equal(v.ok, true);
  }
  // Строка с числом читается как число: параметры приезжают из JSON состояния.
  assert.equal(drawdownGuard({ cumUsd: 0, peakUsd: 20, roundTripUsd: 9, rounds: "2" }).code, "drawdown_stop");
});

test("журнал называет числа и код", () => {
  assert.match(explainDrawdown(drawdownGuard({ cumUsd: 7, peakUsd: 25, roundTripUsd: 9 })), /\$18\.00.*\(drawdown_stop\)/);
  assert.match(explainDrawdown(drawdownGuard({ cumUsd: 10, peakUsd: 25, roundTripUsd: 9 })), /\$15\.00 от пика при пороге \$18\.00/);
  assert.match(explainDrawdown(drawdownGuard({ rounds: 0 })), /выключен/);
  assert.match(explainDrawdown(drawdownGuard({})), /чисел леджера нет/);
});
