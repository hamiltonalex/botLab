// paper-history.test.js - БУМАЖНЫЙ ЛЕДЖЕР БОТА 1 ПРОТИВ ЧИСЕЛ АУДИТА, за год почасовых ставок.
//
// ЧЕМ ЭТОТ ФАЙЛ ОТЛИЧАЕТСЯ ОТ golden.test.js, И ЭТО НЕ ВТОРАЯ КОПИЯ ПРОВЕРКИ. У бота 1 два слоя.
// `golden.test.js` прогоняет фикстуры через АНАЛИТИКУ (`math.js`) и сверяет проценты и путь P&L с
// числами аудита питоновского движка. Здесь те же фикстуры и те же числа аудита, но через ЛЕДЖЕР
// (`paper.js`): открытие позиции, начисление час за часом (GMX непрерывно по секундам, HL одним
// расчётом на пересечённую границу часа), издержки круга, просадка, сводка счёта. До этого файла у
// леджера были только юнит-тесты на отдельные шаги и НИ ОДНОЙ сквозной сверки за год.
//
// ЗАЧЕМ СВЕРЯТЬ ДВА СЛОЯ С ОДНИМ ЭТАЛОНОМ. Потому что совпадение слоёв само по себе есть проверка:
// аналитика считает годовой поток формулой, леджер накапливает его 8761 шагом, и сойтись до цента
// они могут только если обе стороны читают знаки, масштабы и конвенцию расчёта HL одинаково.
// Разъедутся - упадёт ровно один из двух файлов, и станет видно, какой слой сдвинулся.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSpreadCsv } from "../src/engine/format.js";
import { scanTwoLeg } from "../src/engine/math.js";
import { DEFAULT_COSTS, roundTripCost } from "../src/engine/costs.js";
import { openPosition, accrueFromRows, closePosition, positionSummary, accountSummary } from "../src/engine/paper.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOUR_MS = 3600000;
const CAPITAL = 2000; // тот же номинал, на котором сняты числа аудита в golden.test.js

const frame = (token) => parseSpreadCsv(readFileSync(join(HERE, "fixtures", `${token}.csv`), "utf8"));

// Один прогон позиции ТЕМИ ЖЕ входными точками, что зовёт приложение: ни одно правило здесь не
// повторяется, подменены только снабжение (строки вместо сети) и часы (метка строки вместо Date.now).
function run(token, strategy, config) {
  const rows = frame(token);
  const t0 = rows[0].tsHour * 1000;
  const tEnd = rows[rows.length - 1].tsHour * 1000 + HOUR_MS;
  const p = openPosition({
    strategy, instrumentKey: token, config, capital: CAPITAL, leverage: 1, nowMs: t0,
    roundTripCost: roundTripCost(DEFAULT_COSTS, CAPITAL, strategy === "one"),
  });
  const applied = accrueFromRows(p, rows, tEnd);
  closePosition(p, tEnd);
  return { p, applied, rows, summary: positionSummary(p) };
}

test("леджер: год фикстуры начисляется час в час, без не оценённого времени", () => {
  const { p, applied, rows } = run("APT", "two", "A");
  assert.equal(rows.length, 8761, "фикстура APT это год почасовых строк");
  assert.equal(applied.hoursApplied, 8761, "начислен КАЖДЫЙ час: пропуск часа это потерянный фандинг");
  assert.equal(applied.gapSkippedSec, 0, "не оценённого времени быть не должно: история сплошная");
  assert.equal(p.accruals.length, 8761);
  assert.equal(p.equityCurve.length, 8762, "точка открытия плюс шаг на каждый час");
});

// Числа аудита - те же, что в шапке golden.test.js (AUDIT_pnl_formulas_2026-06.md, 1x/$2000).
// Допуск центовый: сверяется то, что показывает журнал, а не сырой double.
for (const [token, config, want] of [["APT", "A", 1067.95], ["ETH", "A", 59.36], ["BTC", "B", 60.43]]) {
  test(`леджер: ${token} конфигурация ${config} накапливает $${want} за год, как считает аналитика`, () => {
    const { p, summary } = run(token, "two", config);
    assert.ok(Math.abs(p.cumFunding - want) < 0.01, `${token}: леджер дал ${p.cumFunding.toFixed(4)}, аудит ${want}`);
    // Нетто = брутто минус круг издержек, замороженный на позиции. Тождество, а не совпадение.
    assert.ok(Math.abs(summary.netPnl - (p.cumFunding - p.roundTripCost)) < 1e-9);
    assert.ok(p.maxDrawdown <= 0, "просадка не бывает положительной");
  });
}

test("леджер: конфигурацию держит ПРАВИЛО, а не прогон", () => {
  // Тот же выбор, что делает приложение. Если правило выбора сдвинется, эта строка это покажет, и
  // книга бота 1 разойдётся вместе с ней - у неё звёздочка стоит по этому же вызову.
  assert.equal(scanTwoLeg(frame("APT"), { token: "APT" }).chosen, "A");
  assert.equal(scanTwoLeg(frame("ETH"), { token: "ETH" }).chosen, "A");
  assert.equal(scanTwoLeg(frame("BTC"), { token: "BTC" }).chosen, "B");
});

test("леджер: обе стороны двуногой и однуногая расходятся по знаку, как велит legModel", () => {
  const a = run("APT", "two", "A").p.cumFunding;
  const b = run("APT", "two", "B").p.cumFunding;
  const one = run("APT", "one", null).p.cumFunding;
  // A и B это противоположные стороны одного рынка: прибыльной может быть только одна.
  assert.ok(a > 0 && b < 0, `A ${a.toFixed(2)} и B ${b.toFixed(2)} обязаны быть разного знака`);
  // Однуногая держит ту же сторону GMX, что A, но без ноги HL, поэтому итог обязан отличаться
  // ровно на поток HL, а не быть копией.
  assert.notEqual(one, a);
  assert.ok(one > 0);
});

test("сводка счёта складывает позиции, а не пересчитывает их заново", () => {
  const runs = [run("APT", "two", "A"), run("BTC", "two", "B"), run("ETH", "one", null)];
  const acc = accountSummary(runs.map((r) => r.p));
  assert.equal(acc.count, 3);
  assert.equal(acc.closed, 3);
  assert.equal(acc.gapSkippedSec, 0);
  const gross = runs.reduce((s, r) => s + r.p.cumFunding, 0);
  const cost = runs.reduce((s, r) => s + r.p.roundTripCost, 0);
  assert.ok(Math.abs(acc.grossPnl - gross) < 1e-9);
  assert.ok(Math.abs(acc.netPnl - (gross - cost)) < 1e-9);
  assert.equal(acc.capitalAll, 3 * CAPITAL);
});
