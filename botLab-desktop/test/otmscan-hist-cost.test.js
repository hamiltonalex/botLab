// otmscan-hist-cost.test.js - модель спреда для исторического бектеста
// (src/engine/otmscan/hist-cost.js).
// Доказывает: (1) обе шкалы переноса дают ровно то, что обещают, и различаются на реальном входе;
// (2) множитель чувствительности линеен, то есть ×2 действительно удваивает издержки;
// (3) за границей измеренной сетки возвращается null, а не ближайшая клетка;
// (4) котировки симметричны вокруг марка и бид никогда не уходит в ноль или ниже;
// (5) таблицы заморожены (случайная мутация невозможна) и монотонны по сроку в полосе, которую
//     сканер реально торгует - это защита от опечатки в цифрах, набранных руками;
// (6) tri-state: мусор на входе даёт null.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  modelledSpread,
  quotesFromMark,
  SPREAD_IV_POINTS,
  SPREAD_PCT_PREMIUM,
  COST_DELTA_EDGES,
  COST_EXPIRY_EDGES_DAYS,
  COST_MODEL_PROVENANCE,
} from "../src/engine/otmscan/hist-cost.js";

const near = (a, b, eps, msg) =>
  assert.ok(a != null && Math.abs(a - b) <= eps, `${msg}: ${a} против ${b}`);

// Живой лучший кандидат обкатки 6: BTC_USDC-25SEP26-66000-C, 48 суток, дельта ~0.40.
const BASE = { deltaAbs: 0.42, daysToExpiry: 48, markUsd: 2848, vegaUsd: 88.5 };

test("обе шкалы считают ровно то, что обещают", () => {
  const iv = modelledSpread({ ...BASE, invariant: "ivPoints" });
  // клетка 32-64 дн × 0.4-0.5 = 0.42 пункта IV
  near(iv.spreadUsd, 0.42 * 88.5, 1e-9, "пункты воли × вега");
  near(iv.spreadIvPoints, 0.42, 1e-9, "обратный перевод сходится");

  const pct = modelledSpread({ ...BASE, invariant: "pctPremium" });
  near(pct.spreadPctPremium, 1.42, 1e-9, "клетка 32-64 дн × 0.4-0.5 в процентах премии");
  near(pct.spreadUsd, (2848 * 1.42) / 100, 1e-9);

  // Шкалы обязаны РАСХОДИТЬСЯ на реальном входе, иначе ось чувствительности была бы декоративной.
  assert.notEqual(Math.round(iv.spreadUsd * 100), Math.round(pct.spreadUsd * 100));
});

test("множитель чувствительности линеен", () => {
  const one = modelledSpread({ ...BASE, scale: 1 });
  const half = modelledSpread({ ...BASE, scale: 0.5 });
  const two = modelledSpread({ ...BASE, scale: 2 });
  near(half.spreadUsd, one.spreadUsd / 2, 1e-9, "половина");
  near(two.spreadUsd, one.spreadUsd * 2, 1e-9, "двойной");
});

test("за границей измеренной сетки - null, а не ближайшая клетка", () => {
  assert.equal(modelledSpread({ ...BASE, deltaAbs: 0.02 }), null, "дельта ниже сетки");
  assert.equal(modelledSpread({ ...BASE, deltaAbs: 0.95 }), null, "дельта выше сетки");
  assert.equal(modelledSpread({ ...BASE, daysToExpiry: -1 }), null, "срок в прошлом");
  // Верхний край по сроку открыт (Infinity), поэтому дальний опцион клетку находит.
  assert.ok(modelledSpread({ ...BASE, daysToExpiry: 300 }) != null, "срок 300 суток лежит в последней строке");
  // Шкала пунктов воли без веги непереводима в доллары.
  assert.equal(modelledSpread({ ...BASE, vegaUsd: null, invariant: "ivPoints" }), null);
  // А шкала процентов премии веги не требует.
  assert.ok(modelledSpread({ ...BASE, vegaUsd: null, invariant: "pctPremium" }) != null);
});

test("котировки симметричны вокруг марка и бид положителен", () => {
  const q = quotesFromMark(BASE);
  near((q.bid + q.ask) / 2, BASE.markUsd, 1e-9, "марк ровно посередине");
  near(q.ask - q.bid, q.spreadUsd, 1e-9, "ширина равна модельной");
  assert.ok(q.bid > 0);

  // Дешёвый однодневный опцион при удвоенном спреде: ширина упирается в потолок, бид остаётся живым.
  const thin = quotesFromMark({ deltaAbs: 0.1, daysToExpiry: 1, markUsd: 5, vegaUsd: 2, scale: 2 });
  assert.ok(thin.bid > 0, "бид не уходит в ноль или ниже");
  assert.ok(thin.spreadPctPremium <= 180.0000001, "ширина ограничена 180% премии");
});

test("таблицы заморожены и монотонны по сроку в торгуемой полосе дельты", () => {
  assert.throws(() => { SPREAD_IV_POINTS[0] = []; }, "верхний уровень заморожен");
  assert.throws(() => { SPREAD_IV_POINTS[0][0] = 999; }, "строка заморожена");
  assert.equal(SPREAD_IV_POINTS.length, COST_EXPIRY_EDGES_DAYS.length - 1);
  assert.equal(SPREAD_PCT_PREMIUM.length, COST_EXPIRY_EDGES_DAYS.length - 1);
  for (const row of [...SPREAD_IV_POINTS, ...SPREAD_PCT_PREMIUM]) {
    assert.equal(row.length, COST_DELTA_EDGES.length - 1);
    for (const v of row) assert.ok(v > 0, "пустых клеток в таблицах нет");
  }
  // Издержки обязаны падать со сроком: это арифметика тарифа (комиссия фиксирована, вега ~√T),
  // и нарушение монотонности означало бы опечатку при наборе. Проверяем в полосе 0.3-0.6,
  // которую сканер реально торгует; колонка 0.6-0.8 не в игре (там вега мала и частное раздуто).
  // Последняя строка (64 дн и дальше) ИСКЛЮЧЕНА осознанно: там медиана клетки опирается на
  // считаные экспирации и монотонность ломается на измеренных данных, а не на опечатке. Оба
  // действующих пресета живут на 7-14 и 28-56 днях, то есть внутри проверяемой области.
  const LAST_MONOTONE_ROW = SPREAD_IV_POINTS.length - 1; // строка 32-64 дн
  for (const di of [2, 3, 4]) {
    for (let ei = 1; ei < LAST_MONOTONE_ROW; ei++) {
      assert.ok(SPREAD_IV_POINTS[ei][di] <= SPREAD_IV_POINTS[ei - 1][di],
        `пункты воли не убывают на строке ${ei}, столбце ${di}`);
      assert.ok(SPREAD_PCT_PREMIUM[ei][di] <= SPREAD_PCT_PREMIUM[ei - 1][di],
        `проценты премии не убывают на строке ${ei}, столбце ${di}`);
    }
  }
});

test("происхождение подписано как допущение", () => {
  assert.equal(COST_MODEL_PROVENANCE.isAssumption, true);
  // Проверяем СМЫСЛ подписи, а не конкретный путь: сама запись лежит вне репозитория, и привязка
  // теста к её местоположению уже однажды сломала сборку при переносе внутренних материалов.
  assert.match(COST_MODEL_PROVENANCE.source, /прогона 5/);
  assert.ok(COST_MODEL_PROVENANCE.windowUtc.includes("2026-08-04"), "названо окно замера");
  assert.ok(COST_MODEL_PROVENANCE.snapshots > 0 && COST_MODEL_PROVENANCE.instruments > 0);
  assert.ok(COST_MODEL_PROVENANCE.caveat.length > 0, "оговорка о режиме рынка не пустая");
});

test("tri-state: мусор даёт null", () => {
  for (const bad of [undefined, {}, { markUsd: 0, deltaAbs: 0.4, daysToExpiry: 10 },
    { markUsd: 100, deltaAbs: NaN, daysToExpiry: 10 }, { markUsd: 100, deltaAbs: 0.4, daysToExpiry: NaN },
    { ...BASE, scale: 0 }, { ...BASE, scale: -1 }]) {
    assert.equal(modelledSpread(bad), null, `вход ${JSON.stringify(bad)}`);
  }
  assert.equal(quotesFromMark({ ...BASE, deltaAbs: 0.95 }), null);
});
