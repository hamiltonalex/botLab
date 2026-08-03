// otmscan-presets.test.js — S0: SCAN_PRESETS как единый источник истины + валидация патча (план §6).
// S1: SCAN_DATA_RULES (структурные правила §7) и снапшот порогов в рождённом сигнале (§8.1).

import test from "node:test";
import assert from "node:assert/strict";
import { SCAN_PRESETS, SCAN_DATA_RULES, defaultScanSettings, normalizeScanPatch, OPTION_FEE_RATE, OPTION_FEE_CAP_PCT_PREMIUM } from "../src/engine/otmscan/presets.js";
import { createScanState, evaluateScan } from "../src/engine/otmscan/scan-engine.js";
import { NOW, PRESET, mkInputs } from "./otmscan-helpers.mjs";

test("пресеты: четыре id, различия v1/v2 по плану, заморожены (в т.ч. вложенные exits)", () => {
  assert.deepEqual(Object.keys(SCAN_PRESETS).sort(), ["calibrated", "delta-v1", "dmitri-v1", "dmitri-v2"]);
  const v1 = SCAN_PRESETS["dmitri-v1"];
  const v2 = SCAN_PRESETS["dmitri-v2"];
  assert.equal(v1.mode, "AND");
  assert.equal(v1.skewMode, "info"); // аудит: спорная логика — не гейт
  assert.equal(v1.imbalanceMode, "off");
  assert.equal(v1.strikeMode, "sigma", "историческое поведение v1 сохранено ради сравнимости с прогоном 3");
  assert.equal(v2.sigmaMin, 0.55);
  assert.equal(v2.execModel, "taker-cross");
  assert.equal(SCAN_PRESETS.calibrated.calibrated, "draft");
  assert.ok(Object.isFrozen(SCAN_PRESETS) && Object.isFrozen(v1) && Object.isFrozen(v1.exits));
  assert.throws(() => {
    v1.premMaxPct = 99;
  }, "мутация пресета обязана бросать (strict mode)");
});

// delta-v1 закрепляется числами: каждое из них ИЗМЕРЕНО на живой поверхности 2026-08-03/04, и
// молчаливый дрейф любого из них ломает связь пресета с замером, ради которого он заведён.
test("delta-v1: пресет пяти правок, числа из живого замера", () => {
  const d = SCAN_PRESETS["delta-v1"];
  assert.equal(d.strikeMode, "delta", "гейт страйка — по живым грекам, а не по σ");
  assert.equal(d.deltaMin, 0.35);
  assert.equal(d.deltaMax, 0.55);
  // σ-окно тут СИТО снабжения, а не гейт: полоса дельты живёт на σ 0.04-0.46 (замер по всем срокам),
  // сито обязано покрывать её с запасом на смену режима IV.
  assert.ok(d.sigmaMin <= 0.04 && d.sigmaMax >= 0.46, "сито обязано покрывать σ-охват полосы дельты");
  // Потолок окна: недельная в 10.5 суток = 252ч, при потолке 240ч она выпадала, а именно она даёт
  // тету 5-6%/сут против 16.6-26.2 у всего, что внутри 48-240ч.
  assert.ok(d.expiryMaxH >= 252, "потолок окна обязан вмещать недельную экспирацию в 252ч");
  assert.equal(d.expiryMinH, 48);
  // Пороги из распределения полосы: премия 0.71-1.71% спота, спред 3.8-6.35% премии.
  assert.ok(d.premMaxPct >= 1.71, "старые 0.4% отвергали полосу дельты целиком");
  assert.ok(d.spreadMaxPctPrem >= 6.35, "старые 3% отвергали полосу дельты целиком");
  // Тета и издержки НЕ менялись осознанно: тета отбирает длинный конец окна, издержки полоса и так
  // проходит с запасом (8.4-11.3% премии против порога 20).
  assert.equal(d.thetaMaxPctDay, SCAN_PRESETS["dmitri-v1"].thetaMaxPctDay);
  assert.equal(d.costMaxPctPrem, SCAN_PRESETS["dmitri-v1"].costMaxPctPrem);
  assert.equal(d.imbalanceMode, "info", "определение ратифицировано, порог нет — считаем, но не гейтим");
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.exits));
});

test("комиссии: верифицированные золотые числа S0", () => {
  assert.equal(OPTION_FEE_RATE, 0.0003); // maker == taker, get_instrument 2026-07-19
  assert.equal(OPTION_FEE_CAP_PCT_PREMIUM, 12.5);
});

test("defaultScanSettings: дефолты плана §6", () => {
  const s = defaultScanSettings();
  assert.equal(s.presetId, "delta-v1", "чистый профиль (то есть обкатка) стартует на новом пресете");
  assert.equal(s.nCandidatesMax, 8, "окно 48-336ч несёт больше страйков полосы, чем прежние шесть");
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
