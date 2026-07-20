// scn-boot.test.js - А6 (fault-tolerance), находка A4/F2: континуальные счётчики сканера
// (dwell FORMING, память гистерезиса) не переживают разрыв рестарта; всё абсолютное
// (ACTIVE-сигнал, cooldowns, журнал, failCount) восстанавливается нетронутым.
import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizeRestoredScanState } from "../src/main/scn-boot.js";
import { createScanState } from "../src/engine/otmscan/scan-engine.js";

const T0 = Date.UTC(2026, 6, 20, 12, 0, 0);

test("FORMING с накопленным dwell сбрасывается в idle: «N подряд тиков» не склеивается через рестарт", () => {
  const persisted = {
    ...createScanState(),
    phase: "forming",
    dwellCount: 2,
    dwellKey: "BTC_USDC-24JUL26-70000-C|call|dmitri-v1",
  };
  const { state, notes } = sanitizeRestoredScanState(persisted);
  assert.equal(state.phase, "idle");
  assert.equal(state.dwellCount, 0);
  assert.equal(state.dwellKey, null);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /dwell сброшен/);
  assert.match(notes[0], /рестартом/);
  // вход не мутирован (редьюсер-дисциплина)
  assert.equal(persisted.phase, "forming");
  assert.equal(persisted.dwellCount, 2);
});

test("память гистерезиса очищается: протухший pass не смягчит первый свежий fail", () => {
  const persisted = { ...createScanState(), hyst: { "u2|rvMargin": "pass", "u10|BTC_USDC-X": "fail" } };
  const { state, notes } = sanitizeRestoredScanState(persisted);
  assert.deepEqual(state.hyst, {});
  assert.equal(notes.length, 1);
  assert.match(notes[0], /гистерезиса очищена \(2 ключей\)/);
  assert.deepEqual(persisted.hyst, { "u2|rvMargin": "pass", "u10|BTC_USDC-X": "fail" }); // вход цел
});

test("ACTIVE-сигнал, failCount и cooldowns восстанавливаются нетронутыми (ревалидация - дело первого тика)", () => {
  const signal = { id: `scn-${T0}-BTC_USDC-24JUL26-70000-C`, ts: T0, instrument: "BTC_USDC-24JUL26-70000-C", ttlSec: 900 };
  const cooldowns = { "BTC_USDC-24JUL26-68000-P|put": T0 + 1800000 };
  const journal = [{ ts: T0, event: "signal", id: signal.id }];
  const persisted = { ...createScanState(), phase: "active", signal, failCount: 1, cooldowns, journal };
  const { state, notes } = sanitizeRestoredScanState(persisted);
  assert.equal(state.phase, "active");
  assert.deepEqual(state.signal, signal);
  assert.equal(state.failCount, 1); // консервативное направление: только ускоряет инвалидацию
  assert.deepEqual(state.cooldowns, cooldowns); // untilTs абсолютен - корректен через разрыв
  assert.deepEqual(state.journal, journal);
  assert.equal(notes.length, 0); // сбрасывать было нечего
});

test("чистое idle-состояние проходит без нот и без изменений; state - всегда новый объект", () => {
  const persisted = createScanState();
  const { state, notes } = sanitizeRestoredScanState(persisted);
  assert.deepEqual(state, persisted);
  assert.notEqual(state, persisted);
  assert.equal(notes.length, 0);
});

test("осиротевший dwell при не-forming фазе зануляется, фаза сохраняется (защитная ветка)", () => {
  const persisted = { ...createScanState(), phase: "idle", dwellCount: 3, dwellKey: "x|call|p" };
  const { state, notes } = sanitizeRestoredScanState(persisted);
  assert.equal(state.phase, "idle");
  assert.equal(state.dwellCount, 0);
  assert.equal(state.dwellKey, null);
  assert.equal(notes.length, 1);
});

test("мусорный вход (null/не-объект) возвращается как есть - решение о re-init принимает загрузчик", () => {
  assert.deepEqual(sanitizeRestoredScanState(null), { state: null, notes: [] });
  assert.deepEqual(sanitizeRestoredScanState("junk"), { state: "junk", notes: [] });
});
