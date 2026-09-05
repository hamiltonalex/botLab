// fa-decay.test.js - НАБЛЮДЕНИЕ ЗАТУХАНИЯ ФАНДИНГА GMX (fa/decay.js): ряд убывания, шаг и час нуля по
// тренду, переворот, перекос интереса, дыры и плато, живой снимок, отсутствие данных.

import test from "node:test";
import assert from "node:assert/strict";
import { FA_DECAY_STATUSES, decayObservation, explainDecay } from "../src/engine/fa/decay.js";
import { row, BASE_S, HOUR_MS } from "./fa-helpers.mjs";

const SEC_PER_YEAR = 3600 * 8760;
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) < tol, `${label}: got ${a}, want ${b}`);
// Ряд ставок длинной стороны по часам: f_long задан списком.
const series = (fl) => fl.map((v, h) => row(h, { fl: v, fs: -v }));

test("реестр статусов и пустой вход", () => {
  assert.deepEqual([...FA_DECAY_STATUSES], ["unknown", "none", "declining", "flipped"]);
  const v = decayObservation();
  assert.equal(v.known, false);
  assert.equal(v.status, "unknown");
  assert.equal(v.runHours, 0);
  assert.equal(decayObservation({ rows: [], live: { f_long: NaN } }).known, false);
  assert.match(explainDecay(v), /ставки своей стороны нет/);
});

test("живой эпизод BTC: линейное убывание 1.6e-10 в час, ноль по тренду через f/шаг часов", () => {
  // 5.0e-9 .. 1.0e-9 за 25 шагов
  const fl = Array.from({ length: 26 }, (_, i) => 5e-9 - i * 1.6e-10);
  const rows = series(fl);
  const last = rows[rows.length - 1];
  const liveAt = (last.tsHour + 1800) * 1000; // полчаса после начала последней строки
  const v = decayObservation({ rows, gmxSide: "long", live: { f_long: 9.2e-10, f_short: -1e-9, fbase_long: 12.66e6, fbase_short: 11.0e6 }, liveAtMs: liveAt });
  assert.equal(v.known, true);
  assert.equal(v.status, "declining");
  assert.equal(v.runHours, 26, "25 шагов по строкам плюс живой снимок ниже последней строки");
  assert.equal(v.liveContinues, true);
  near(v.stepPerHour, -1.6e-10, 1e-18, "средний шаг");
  near(v.fNow, 9.2e-10, 1e-20, "ставка сейчас это живой снимок");
  assert.equal(v.fNowAtMs, liveAt);
  near(v.hoursToZero, 9.2e-10 / 1.6e-10, 1e-9, "часов до нуля");
  near(v.zeroAtMs, liveAt + (9.2e-10 / 1.6e-10) * HOUR_MS, 1, "час нуля по тренду");
  near(v.aprNow, 9.2e-10 * SEC_PER_YEAR, 1e-12, "годовых");
  near(v.stepAprPerHour, -1.6e-10 * SEC_PER_YEAR, 1e-12, "шаг в годовых за час");
  near(v.skewFrac, (12.66 - 11.0) / (12.66 + 11.0), 1e-12, "перекос: своя сторона больше");
  assert.equal(v.belowZeroHours, 0);
  assert.match(explainDecay(v), /убывает 26 ч подряд, ноль по тренду через 5\.8 ч/);
});

test("плато и дыра обрывают ряд; один шаг это ряд без тренда", () => {
  const plateau = series([3e-9, 3e-9, 2e-9, 1e-9]);
  const v1 = decayObservation({ rows: plateau, gmxSide: "long" });
  assert.equal(v1.runHours, 2, "плато в начале не считается");
  near(v1.stepPerHour, -1e-9, 1e-20, "шаг по двум последним");
  const holed = series([4e-9, 3e-9, 2e-9, 1e-9]);
  holed[2].tsHour += 3600; // дыра: между второй и третьей строкой два часа
  holed[3].tsHour += 3600;
  const v2 = decayObservation({ rows: holed, gmxSide: "long" });
  assert.equal(v2.runHours, 1, "ряд считается только через дыру назад до неё");
  assert.equal(v2.stepPerHour, null, "одного шага для тренда мало");
  assert.equal(v2.hoursToZero, null);
  assert.equal(v2.status, "declining");
  assert.match(explainDecay(v2), /убывает 1 ч подряд$/);
  const flat = decayObservation({ rows: series([2e-9, 2e-9, 2e-9]), gmxSide: "long" });
  assert.equal(flat.status, "none");
  assert.equal(flat.runHours, 0);
  assert.match(explainDecay(flat), /ряда убывания нет/);
});

test("переворот: ставка своей стороны ниже нуля, часы ниже нуля считаются по строкам", () => {
  const rows = series([1e-9, 5e-10, 0, -5e-10, -1e-9]);
  const v = decayObservation({ rows, gmxSide: "long", live: { f_long: -1.2e-9, f_short: 1e-9 } });
  assert.equal(v.status, "flipped");
  assert.equal(v.belowZeroHours, 3, "0, -5e-10, -1e-9");
  assert.equal(v.runHours, 5, "убывание продолжается и ниже нуля: 4 шага плюс живой");
  assert.equal(v.hoursToZero, null, "ноль уже пройден");
  assert.equal(v.zeroAtMs, null);
  assert.match(explainDecay(v), /платим мы, ниже нуля 3 ч/);
});

test("короткая нога читает f_short и базу короткой стороны; живой снимок выше последней строки ряд не продлевает", () => {
  const rows = [row(0, { fs: 3e-9, fl: -3e-9 }), row(1, { fs: 2e-9, fl: -2e-9 }), row(2, { fs: 1e-9, fl: -1e-9 })];
  const v = decayObservation({ rows, gmxSide: "short", live: { f_short: 1.5e-9, f_long: -1.5e-9, fbase_short: 4e6, fbase_long: 6e6 }, liveAtMs: (BASE_S + 3 * 3600 + 60) * 1000 });
  assert.equal(v.side, "short");
  assert.equal(v.runHours, 2);
  assert.equal(v.liveContinues, false, "живой снимок выше последней строки");
  near(v.fNow, 1.5e-9, 1e-20, "ставка сейчас всё равно живая");
  near(v.skewFrac, (4 - 6) / 10, 1e-12, "своя сторона меньше встречной: перекос отрицательный");
  assert.equal(v.status, "declining");
});

test("без живого снимка ставка сейчас это последняя строка, момент это конец её часа; базы без снимка неизвестны", () => {
  const rows = series([2e-9, 1.5e-9, 1e-9]);
  const v = decayObservation({ rows, gmxSide: "long", nowMs: 1 });
  near(v.fNow, 1e-9, 1e-20, "последняя строка");
  assert.equal(v.fNowAtMs, (BASE_S + 3 * 3600) * 1000);
  assert.equal(v.liveContinues, null);
  assert.equal(v.skewFrac, null);
  near(v.hoursToZero, 2, 1e-9, "1e-9 при шаге 5e-10 в час");
  assert.equal(v.zeroAtMs, (BASE_S + 5 * 3600) * 1000);
});

test("строки без ставки своей стороны пропускаются, а неконечные базы не дают перекоса", () => {
  const rows = [row(0, { fl: 3e-9 }), { tsHour: BASE_S + 3600, f_long: NaN }, row(2, { fl: 2e-9 }), row(3, { fl: 1e-9 })];
  const v = decayObservation({ rows, gmxSide: "long", live: { f_long: 5e-10, fbase_long: 0, fbase_short: 1e6 } });
  assert.equal(v.rowsUsed, 3);
  assert.equal(v.runHours, 2, "строка без ставки выпала, шаг между 2 и 3 ровно час");
  assert.equal(v.skewFrac, null, "нулевая база это не наблюдение");
});
