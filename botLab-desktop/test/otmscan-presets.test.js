// otmscan-presets.test.js — S0: SCAN_PRESETS как единый источник истины + валидация патча (план §6).

import test from "node:test";
import assert from "node:assert/strict";
import { SCAN_PRESETS, defaultScanSettings, normalizeScanPatch, OPTION_FEE_RATE, OPTION_FEE_CAP_PCT_PREMIUM } from "../src/engine/otmscan/presets.js";

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
