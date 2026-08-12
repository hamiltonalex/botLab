// otmscan-exits.test.js — правила выхода Е1-Е7 (exits.js). Проверяется прежде всего ПОРЯДОК:
// при одновременном срабатывании двух правил отчёт обязан называть одну и ту же причину, иначе
// разбор сделок разъедется между запусками.

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateExit, walkExit, EXIT_REASONS } from "../src/engine/otmscan/exits.js";

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

// ── ПРОТЯЖКА. Главное здесь не «нашёлся ли тейк», а то, что позиция НЕ МОЖЕТ ИСЧЕЗНУТЬ: любой
// исход обязан получить причину. Ровно это однажды и сломалось (проверка 2026-08-12): протяжка
// возвращала null, когда инструмент пропадал из записи до экспирации, вызывающий отфильтровывал
// null, и 57 заведомо убыточных позиций из 1113 уходили из отчёта, переворачивая знак результата.

const H = 3600000;
// Наблюдения задаются марками по часам после входа; null означает «инструмента в записи нет».
const walkMarks = (marks, exits = X, entry = {}) => walkExit({
  count: marks.length,
  at: (k) => (marks[k] == null ? null : { tsMs: (k + 1) * H, markUsd: marks[k], ivPct: 40,
    hoursToExpiry: 500, moveSigma: 1.0 }),
  entryTsMs: 0, entryMarkUsd: 100, entryIvPct: 40, exits, ...entry,
});

test("протяжка: выход на первом же снимке, где правило сработало", () => {
  const r = walkMarks([100, 105, 190, 300]);
  assert.equal(r.reason, EXIT_REASONS.TAKE);
  assert.equal(r.index, 2, "берётся ПЕРВЫЙ сработавший снимок, а не лучший");
  assert.equal(r.markUsd, 190);
  assert.equal(r.heldH, 3);
});

test("протяжка: правило не сработало, инструмент дожил до конца записи — «конец записи»", () => {
  const r = walkMarks([100, 101, 102]);
  assert.equal(r.reason, EXIT_REASONS.END_OF_RECORD);
  assert.equal(r.index, 2);
  assert.equal(r.markUsd, 102);
});

// Марки ниже держатся в полосе 65..190, где ни одно правило пресета X не срабатывает: иначе
// проверялась бы не пропажа, а стоп −35%, который сработал бы раньше.
test("протяжка: инструмент ПРОПАЛ до конца записи — позиция закрывается, а не исчезает", () => {
  const r = walkMarks([100, 90, 80, null, null, null]);
  assert.equal(r.reason, EXIT_REASONS.VANISHED, "исчезновение обязано получить свою причину");
  assert.equal(r.index, 2, "закрытие по ПОСЛЕДНЕМУ снимку, где инструмент ещё был");
  assert.equal(r.markUsd, 80);
  assert.equal(r.heldH, 3);
});

test("протяжка: «пропал» и «конец записи» это РАЗНЫЕ исходы и не должны смешиваться", () => {
  assert.equal(walkMarks([100, 80, null]).reason, EXIT_REASONS.VANISHED);
  assert.equal(walkMarks([100, 80]).reason, EXIT_REASONS.END_OF_RECORD);
});

test("протяжка: дыра в середине не считается пропажей, если инструмент вернулся", () => {
  const r = walkMarks([100, null, null, 190]);
  assert.equal(r.reason, EXIT_REASONS.TAKE);
  assert.equal(r.index, 3);
});

test("протяжка: правило важнее пропажи, если сработало раньше", () => {
  const r = walkMarks([100, 65, 5, null]);
  assert.equal(r.reason, EXIT_REASONS.STOP, "стоп сработал на втором снимке, до исчезновения");
  assert.equal(r.index, 1);
});

test("протяжка: ни одного снимка после входа — null, и это ЕДИНСТВЕННЫЙ такой случай", () => {
  assert.equal(walkMarks([null, null, null]), null);
  assert.equal(walkMarks([]), null, "шагов нет вовсе");
  assert.equal(walkExit({ count: 0, at: () => null, entryMarkUsd: 100, exits: X }), null);
});

test("протяжка: без входных данных — null, а не выдуманный выход", () => {
  assert.equal(walkExit(), null);
  assert.equal(walkExit({ count: 3, at: () => null, entryMarkUsd: 0, exits: X }), null);
  assert.equal(walkExit({ count: 3, at: null, entryMarkUsd: 100, exits: X }), null);
  assert.equal(walkExit({ count: 2.5, at: () => null, entryMarkUsd: 100, exits: X }), null);
});

// `at` вправе отдавать одну и ту же структуру, переписывая её поля: так делают горячие циклы,
// чтобы не аллоцировать на шаг. Если протяжка удержит ССЫЛКУ на последний живой снимок, к моменту
// закрытия «пропал» она прочитает уже чужие значения, и позиция закроется по неверной цене.
test("протяжка: `at` может переиспользовать один объект, закрытие всё равно верное", () => {
  const marks = [100, 90, 80, null, null];
  const pooled = { tsMs: 0, markUsd: 0, ivPct: 40, hoursToExpiry: 500, moveSigma: 1.0 };
  const r = walkExit({
    count: marks.length,
    at: (k) => {
      pooled.tsMs = (k + 1) * H;            // структура переписывается на каждом шаге
      pooled.markUsd = marks[k] ?? -1;
      return marks[k] == null ? null : pooled;
    },
    entryTsMs: 0, entryMarkUsd: 100, entryIvPct: 40, exits: X,
  });
  assert.equal(r.reason, EXIT_REASONS.VANISHED);
  assert.equal(r.markUsd, 80, "цена последнего живого снимка, а не то, что осталось в структуре");
  assert.equal(r.tsMs, 3 * H);
  assert.equal(r.heldH, 3);
});

test("протяжка: возраст считается от метки ВХОДА, а не от первого снимка", () => {
  const r = walkExit({ count: 3,
    at: (k) => ({ tsMs: 100 * H + (k + 1) * H, markUsd: 100, ivPct: 40, hoursToExpiry: 500, moveSigma: 1 }),
    entryTsMs: 100 * H, entryMarkUsd: 100, entryIvPct: 40, exits: { ...X, timeStopH: 2, minMoveSigma: 0 } });
  assert.equal(r.reason, EXIT_REASONS.END_OF_RECORD, "moveSigma 1 больше minMoveSigma 0, тайм-стоп молчит");
  assert.equal(r.heldH, 3);
});
