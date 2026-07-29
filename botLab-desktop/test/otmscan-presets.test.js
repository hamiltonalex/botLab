// otmscan-presets.test.js — S0: SCAN_PRESETS как единый источник истины + валидация патча (план §6).
// S1: SCAN_DATA_RULES (структурные правила §7) и снапшот порогов в рождённом сигнале (§8.1).

import test from "node:test";
import assert from "node:assert/strict";
import { SCAN_PRESETS, SCAN_DATA_RULES, defaultScanSettings, normalizeScanPatch, OPTION_FEE_RATE, OPTION_FEE_CAP_PCT_PREMIUM } from "../src/engine/otmscan/presets.js";
import { createScanState, evaluateScan } from "../src/engine/otmscan/scan-engine.js";
import { NOW, PRESET, mkInputs } from "./otmscan-helpers.mjs";

test("пресеты: три id, различия v1/v2 по плану, заморожены (в т.ч. вложенные exits)", () => {
  assert.deepEqual(Object.keys(SCAN_PRESETS).sort(), ["calibrated", "dmitri-v1", "dmitri-v2"]);
  const v1 = SCAN_PRESETS["dmitri-v1"];
  const v2 = SCAN_PRESETS["dmitri-v2"];
  assert.equal(v1.mode, "AND");
  assert.equal(v1.skewMode, "info"); // аудит: спорная логика — не гейт
  assert.equal(v1.imbalanceMode, "off"); // до ратификации Д5
  assert.equal(v2.sigmaMin, 0.55);
  assert.equal(v2.execModel, "taker-cross");
  assert.equal(SCAN_PRESETS.calibrated.calibrated, "draft");
  assert.ok(Object.isFrozen(SCAN_PRESETS) && Object.isFrozen(v1) && Object.isFrozen(v1.exits));
  assert.throws(() => {
    v1.premMaxPct = 99;
  }, "мутация пресета обязана бросать (strict mode)");
});

test("комиссии: верифицированные золотые числа S0", () => {
  assert.equal(OPTION_FEE_RATE, 0.0003); // maker == taker, get_instrument 2026-07-19
  assert.equal(OPTION_FEE_CAP_PCT_PREMIUM, 12.5);
});

test("defaultScanSettings: дефолты плана §6", () => {
  const s = defaultScanSettings();
  assert.equal(s.presetId, "dmitri-v1");
  assert.equal(s.equityUsd, 100);
  assert.equal(s.sigmaConvention, "horizon");
  assert.equal(s.scanRepriceSec, 30);
});

test("normalizeScanPatch: невалидное отклоняется с ошибкой (не коерция), валидное проходит", () => {
  const good = normalizeScanPatch({ scanRepriceSec: 60, riskPerTradePct: 10 });
  assert.equal(good.ok, true);
  assert.deepEqual(good.value, { scanRepriceSec: 60, riskPerTradePct: 10 });

  const bad = normalizeScanPatch({ scanRepriceSec: 0, sigmaConvention: "bogus", equityUsd: 500 });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
  assert.deepEqual(bad.value, { equityUsd: 500 }); // хорошие ключи выживают, плохие вырезаны
});

test("normalizeScanPatch: неизвестные ключи проходят без проверки (forward-совместимость)", () => {
  const r = normalizeScanPatch({ someFutureKnob: 42 });
  assert.equal(r.ok, true);
  assert.equal(r.value.someFutureKnob, 42);
});

test("SCAN_DATA_RULES (S1): структурные правила §7 заморожены — блэкаут как у бота 2", () => {
  assert.ok(Object.isFrozen(SCAN_DATA_RULES));
  assert.equal(SCAN_DATA_RULES.blackoutDailyWindowSec, 600);
  assert.equal(SCAN_DATA_RULES.blackoutPreExpirySec, 1800);
  assert.equal(SCAN_DATA_RULES.staleCandlesSec, 300);
  assert.equal(SCAN_DATA_RULES.journalMax, 200);
  assert.equal(SCAN_DATA_RULES.minLotFallback, 0.01);
});

test("сигнал несёт ПОЛНЫЙ снапшот порогов рождения — глубокая копия, не ссылка (§8.1)", () => {
  let st = createScanState();
  for (let i = 0; i < 3; i++) st = evaluateScan(st, mkInputs(NOW + i * 30000), PRESET, NOW + i * 30000).state;
  const sig = st.signal;
  assert.ok(sig, "сигнал рождён за dwellTicks=3");
  assert.equal(sig.presetId, "dmitri-v1");
  assert.deepEqual(sig.thresholds, { ...PRESET, exits: { ...PRESET.exits } });
  assert.notEqual(sig.thresholds, PRESET, "снимок, не ссылка");
  sig.thresholds.premMaxPct = 99; // мутация снимка не задевает источник истины
  assert.equal(PRESET.premMaxPct, 0.4);
  assert.equal(SCAN_PRESETS["dmitri-v1"].premMaxPct, 0.4);
});
