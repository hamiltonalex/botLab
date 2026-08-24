// otmscan-hist-gate.test.js - входной гейт схемы продавца как измерительный инструмент
// (src/engine/otmscan/hist-gate.js).
// Доказывает: (1) спецификация разбирается вместе со знаком, а двухсимвольные знаки не съедаются
// односимвольными; (2) мусор на входе даёт НАЗВАННУЮ ошибку, а не молча посчитанный не тот прогон;
// (3) сравнение считает ровно то, что обещает, включая попадание ровно на порог; (4) «нет данных»
// является вето и попадает в ОТДЕЛЬНЫЙ счётчик, а не в общий с отказом по значению; (5) счётчик
// именует первую не прошедшую ось и на ней останавливается (сумма по осям не превышает числа
// отклонённых входов); (6) таблица осей заморожена.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GATE_AXES,
  parseGateSpec,
  formatGateTerms,
  makeGateCounter,
  testGate,
} from "../src/engine/otmscan/hist-gate.js";

// Живой вход схемы: колл 336-672 ч, IV ноги 52.4%, RV7d 44.1% (разрыв +8.3 п.в.), спокойный рынок.
const CALM = { ivrv: 8.3, imp: 1.2, skew: -1.5 };

test("спецификация разбирается: ось, знак, порог", () => {
  const { terms, error } = parseGateSpec("ivrv>=5");
  assert.equal(error, null);
  assert.deepEqual(terms, [{ axis: "ivrv", op: ">=", thr: 5 }]);
});

test("двухсимвольный знак не съедается односимвольным", () => {
  assert.deepEqual(parseGateSpec("imp<=3").terms, [{ axis: "imp", op: "<=", thr: 3 }]);
  assert.deepEqual(parseGateSpec("imp<3").terms, [{ axis: "imp", op: "<", thr: 3 }]);
  // Отрицательный порог не должен быть спутан со знаком сравнения.
  assert.deepEqual(parseGateSpec("skew<=-2").terms, [{ axis: "skew", op: "<=", thr: -2 }]);
});

test("несколько условий разбираются в порядке спецификации", () => {
  const { terms } = parseGateSpec(" ivrv>=5 , imp<=3 ");
  assert.deepEqual(terms, [{ axis: "ivrv", op: ">=", thr: 5 }, { axis: "imp", op: "<=", thr: 3 }]);
});

test("мусор даёт названную ошибку, а не молчаливый прогон", () => {
  assert.match(parseGateSpec("").error, /пустая/);
  assert.match(parseGateSpec("ivrv5").error, /знака сравнения/);
  assert.match(parseGateSpec("vega>=5").error, /ось «vega»/);
  assert.match(parseGateSpec("ivrv>=абв").error, /не число/);
  assert.equal(parseGateSpec("ivrv>=5").error, null);
});

test("подпись гейта называет величину, знак, порог и единицы", () => {
  const { terms } = parseGateSpec("ivrv>=5,skew<=-2");
  assert.equal(formatGateTerms(terms), "IV ноги − RV7d ≥ 5 п.в. · скос ±1σ (пут−колл) ≤ -2 п.в.");
});

test("сравнение считает ровно то, что обещает", () => {
  const gate = (spec) => testGate(parseGateSpec(spec).terms, CALM);
  assert.equal(gate("ivrv>=5"), true); // 8.3 ≥ 5
  assert.equal(gate("ivrv>=10"), false); // 8.3 < 10
  assert.equal(gate("imp<=3"), true); // 1.2 ≤ 3
  assert.equal(gate("skew<=-2"), false); // −1.5 не ниже −2: коллы дороже недостаточно
  assert.equal(gate("ivrv>=5,imp<=3"), true); // И, а не ИЛИ
  assert.equal(gate("ivrv>=5,imp<=1"), false);
});

test("попадание ровно на порог решает знак, а не умолчание", () => {
  const on = { ivrv: 5, imp: 3, skew: 0 };
  assert.equal(testGate(parseGateSpec("ivrv>=5").terms, on), true);
  assert.equal(testGate(parseGateSpec("ivrv>5").terms, on), false);
  assert.equal(testGate(parseGateSpec("imp<=3").terms, on), true);
  assert.equal(testGate(parseGateSpec("imp<3").terms, on), false);
});

test("нет данных - вето, и счётчик держит его ОТДЕЛЬНО от отказа по значению", () => {
  const terms = parseGateSpec("ivrv>=5").terms;
  const c = makeGateCounter();
  assert.equal(testGate(terms, { ivrv: null }, c), false); // записи без rv7
  assert.equal(testGate(terms, { ivrv: 1.0 }, c), false); // разрыв есть, но мал
  assert.equal(testGate(terms, { ivrv: 9.0 }, c), true);
  assert.deepEqual(
    { checked: c.checked, passed: c.passed, blocked: c.blocked, noData: c.noData },
    { checked: 3, passed: 1, blocked: 1, noData: 1 },
  );
  assert.deepEqual(c.byAxis, { ivrv: { blocked: 1, noData: 1 } });
});

test("NaN и undefined на оси считаются отсутствием данных, а не нулём", () => {
  const terms = parseGateSpec("imp<=3").terms;
  const c = makeGateCounter();
  assert.equal(testGate(terms, { imp: NaN }, c), false);
  assert.equal(testGate(terms, {}, c), false);
  assert.equal(c.noData, 2);
  assert.equal(c.blocked, 0);
});

test("счётчик именует ПЕРВУЮ не прошедшую ось и на ней останавливается", () => {
  const terms = parseGateSpec("ivrv>=5,imp<=3").terms;
  const c = makeGateCounter();
  // Обе оси не проходят: разрыв мал И импульс велик. Отклонённый вход ОДИН.
  assert.equal(testGate(terms, { ivrv: 1, imp: 9 }, c), false);
  assert.equal(c.blocked, 1);
  assert.equal(c.byAxis.ivrv.blocked, 1);
  assert.equal(c.byAxis.imp, undefined);
  const sum = Object.values(c.byAxis).reduce((s, b) => s + b.blocked + b.noData, 0);
  assert.equal(sum, c.blocked + c.noData);
});

test("пустой набор условий пропускает всё: гейта нет - это база", () => {
  const c = makeGateCounter();
  assert.equal(testGate([], CALM, c), true);
  assert.equal(testGate(null, CALM, c), true);
  assert.equal(c.passed, 2);
});

test("в подписи оси нет вертикальной черты: отчёт печатается markdown-таблицей", () => {
  // Поймано сквозным прогоном: подпись «импульс |ΔP24h|/σ1d» разрезала строку таблицы на лишние
  // ячейки. Ось добавляют редко, а ломает это тихо - поэтому инвариант, а не память.
  for (const [key, axis] of Object.entries(GATE_AXES)) {
    assert.ok(!axis.label.includes("|"), `ось ${key}: в подписи «${axis.label}» есть |`);
    assert.ok(!axis.unit.includes("|"), `ось ${key}: в единицах «${axis.unit}» есть |`);
  }
  const { terms } = parseGateSpec("ivrv>=5,imp<=3,skew<=0");
  assert.ok(!formatGateTerms(terms).includes("|"));
});

test("таблица осей заморожена", () => {
  assert.deepEqual(Object.keys(GATE_AXES), ["ivrv", "imp", "skew"]);
  assert.throws(() => { GATE_AXES.ivrv = null; }, TypeError);
  assert.throws(() => { GATE_AXES.imp.unit = "%"; }, TypeError);
});
