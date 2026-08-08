// otmscan-presets.test.js — S0: SCAN_PRESETS как единый источник истины + валидация патча (план §6).
// S1: SCAN_DATA_RULES (структурные правила §7) и снапшот порогов в рождённом сигнале (§8.1).

import test from "node:test";
import assert from "node:assert/strict";
import { SCAN_PRESETS, SCAN_DATA_RULES, defaultScanSettings, normalizeScanPatch, OPTION_FEE_RATE, OPTION_FEE_CAP_PCT_PREMIUM } from "../src/engine/otmscan/presets.js";
import { createScanState, evaluateScan } from "../src/engine/otmscan/scan-engine.js";
import { NOW, PRESET, mkInputs } from "./otmscan-helpers.mjs";

test("пресеты: шесть id, различия v1/v2 по плану, заморожены (в т.ч. вложенные exits)", () => {
  assert.deepEqual(Object.keys(SCAN_PRESETS).sort(), ["calibrated", "delta-v1", "dmitri-v1", "dmitri-v2", "measure-far-v1", "measure-v1"]);
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
  assert.equal(s.presetId, "measure-far-v1", "чистый профиль (то есть обкатка) стартует на новом пресете");
  assert.equal(s.nCandidatesMax, 8, "окно 48-336ч несёт больше страйков полосы, чем прежние шесть");
  // Депозит и пресет связаны: на 28-56 днях премия контракта 4.55% спота, минимальный лот даёт
  // minCapital $146-161, и при $100 гейт computeSizing снял бы 100% тактов по min_lot_exceeds_risk.
  assert.equal(s.equityUsd, 500);
  const far = SCAN_PRESETS[s.presetId];
  assert.ok(far, "дефолтный пресет обязан существовать в SCAN_PRESETS");
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
  assert.equal(SCAN_DATA_RULES.journalMax, 1000); // 86 сигналов за трое суток на measure-v1: двухнедельная обкатка переполнила бы 200
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

// measure-v1 закрепляется теми же числами, что и delta-v1: они ИЗМЕРЕНЫ по записи прогона 5, и
// молчаливый дрейф любого из них рвёт связь пресета с замером, ради которого он заведён.
test("measure-v1: окно ровно 168 ч и волатильностная группа в info", () => {
  const m = SCAN_PRESETS["measure-v1"];
  // Ширина ровно неделя — не подобранное число: все экспирации кроме дневных приходятся на пятницы
  // с шагом 7 суток, поэтому такое окно содержит ровно одну экспирацию в любой момент (замер по
  // записи прогона 5: 100.00% тактов против 13.38% пустоты при 6 сутках и 32.58% двойных при 8).
  assert.equal(m.expiryMaxH - m.expiryMinH, 168, "ширина окна обязана быть ровно неделей");
  // Потолок против горизонта листинга обычной недельной (14.99 суток, замер по записи): запас 24 ч.
  assert.ok(m.expiryMaxH <= 336, "потолок окна обязан оставаться внутри горизонта листинга");
  // far-нога У6 обязана лежать ВНЕ окна, иначе forward-IV сравнивал бы экспирацию саму с собой.
  assert.ok(m.fivFarMinDays * 24 > m.expiryMaxH, "far-экспирация обязана быть за пределами окна");
  for (const k of ["rv7dMode", "ivDiscountMode", "rv3dMode", "forwardIvMode"]) {
    assert.equal(m[k], "info", `${k}: волатильностная группа измеряется, но вход не решает`);
  }
  assert.equal(m.impulseMin, 0.4);
  assert.equal(m.calibrated, false, "это конфигурация сбора данных, а не калибровка");
  // Инструментные пороги не тронуты: их чинит арифметика тарифа, а не режим рынка.
  const d = SCAN_PRESETS["delta-v1"];
  for (const k of ["deltaMin", "deltaMax", "premMaxPct", "spreadMaxPctPrem", "thetaMaxPctDay", "costMaxPctPrem", "depthMinUsd"]) {
    assert.equal(m[k], d[k], `${k}: инструментный порог обязан совпадать с delta-v1`);
  }
});

test("режимы условий: дефолт gate у всех отгруженных пресетов кроме measure-v1", () => {
  for (const id of ["dmitri-v1", "dmitri-v2", "delta-v1", "calibrated"]) {
    for (const k of ["rv7dMode", "ivDiscountMode", "rv3dMode", "forwardIvMode"]) {
      assert.equal(SCAN_PRESETS[id][k], "gate", `${id}.${k}`);
    }
  }
});

// measure-far-v1: тот же чеклист на сроке, где комиссия перестаёт съедать результат. Числа
// измерены по записи прогона 5, дрейф любого из них рвёт связь пресета с замером.
test("measure-far-v1: дальнее окно и пороги, поехавшие вслед за сроком", () => {
  const f = SCAN_PRESETS["measure-far-v1"];
  const m = SCAN_PRESETS["measure-v1"];
  assert.equal(f.expiryMinH, 672); // 28 суток: недельные котируются лишь до 15, полоса 15-28 пуста
  assert.equal(f.expiryMaxH, 1344); // 56 суток: 28-56 дают ровно одну экспирацию 93% времени
  assert.ok(f.fivFarMinDays * 24 > f.expiryMaxH, "far-нога У6 обязана лежать вне окна");
  assert.equal(f.premMaxPct, 5.0, "премия дальних 4.55% спота медиана, 5.00 максимум");
  assert.equal(f.thetaMaxPctDay, 3.0, "гарантия от сползания к коротким срокам, факт 1.13-1.50");
  // Всё остальное наследуется от measure-v1 без изменений: меняется срок, а не логика отбора.
  for (const k of ["strikeMode", "deltaMin", "deltaMax", "impulseMin", "spreadMaxPctPrem",
    "costMaxPctPrem", "rv7dMode", "ivDiscountMode", "rv3dMode", "forwardIvMode"]) {
    assert.equal(f[k], m[k], `${k}: отличаться от measure-v1 обязан ТОЛЬКО срок и связанное с ним`);
  }
});
