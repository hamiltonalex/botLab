// otmscan-sell-presets.test.js - ИМЕНОВАННЫЕ ПРЕСЕТЫ СХЕМЫ ПРОДАВЦА: реестр, разрешение
// конфигурации (resolveSellCfg), паспорт сделки (presetId в engineCfg) и прохождение пресета
// существующим путём sellCfg до строителя структуры.
//
// ЧЕМ ЭТОТ ФАЙЛ ЗАКРЫВАЕТ ДЫРУ, КОТОРУЮ КНИГИ НЕ ВИДЯТ. Пятилетние книги снимают ОФЛАЙН-тракты, а
// они имени пресета не передают и работают на дефолтах схемы. Значит правка боевого пресета книги
// не двигает, и `npm run guard` её не заметит. Цепочка охраны замыкается здесь: книги стерегут
// SELLHEDGE_DEFAULTS, а тест «боевой пресет = те же числа, что у дефолтов» стережёт равенство
// боевой конфигурации тем числам, которыми книги сняты. Порвётся любое звено - упадёт что-то одно.

import test from "node:test";
import assert from "node:assert/strict";
import {
  SELLHEDGE_DEFAULTS, SELL_PRESETS, SELL_PRESET_DEFAULT_ID,
  isKnownSellPreset, resolveSellCfg, sellhedgeEngineCfg,
} from "../src/engine/otmscan/sellhedge.js";
import { buildSellStructure } from "../src/engine/btcopt/structure.js";

const LIVE = "sell-call-336-672-v1";
const SHORT = "sell-call-168-336-v1";

test("реестр: ключ равен id, у каждого пресета имя и булева пометка замера", () => {
  for (const [key, p] of Object.entries(SELL_PRESETS)) {
    assert.equal(p.id, key, `ключ реестра и id разошлись у ${key}`);
    assert.equal(typeof p.label, "string");
    assert.ok(p.label.length > 0, `${key}: имя непустое`);
    assert.equal(typeof p.calibrated, "boolean", `${key}: замерен или нет - ответ обязателен`);
    assert.ok(p.cfg && typeof p.cfg === "object");
  }
  assert.ok(Object.keys(SELL_PRESETS).length >= 2, "пресетов не меньше двух");
  assert.equal(SELL_PRESET_DEFAULT_ID, LIVE);
});

test("реестр заморожен насквозь: конфигурацию не переписать на ходу", () => {
  assert.ok(Object.isFrozen(SELL_PRESETS));
  assert.ok(Object.isFrozen(SELL_PRESETS[LIVE]));
  assert.ok(Object.isFrozen(SELL_PRESETS[LIVE].cfg));
  assert.throws(() => { "use strict"; SELL_PRESETS[LIVE].cfg.expiryMinH = 1; }, TypeError);
});

test("resolveSellCfg без аргумента тождественна прежнему слиянию: книги не двигаются", () => {
  assert.deepEqual(resolveSellCfg(), { ...SELLHEDGE_DEFAULTS });
  assert.deepEqual(resolveSellCfg(null), { ...SELLHEDGE_DEFAULTS });
  assert.deepEqual(resolveSellCfg({}), { ...SELLHEDGE_DEFAULTS });
  assert.equal(resolveSellCfg().presetId, undefined, "офлайн-тракт имени пресета не получает");
});

test("боевой пресет несёт ТЕ ЖЕ окно, дельту и полосу, какими сняты пятилетние книги", () => {
  const cfg = resolveSellCfg({ presetId: LIVE });
  assert.equal(cfg.expiryMinH, SELLHEDGE_DEFAULTS.expiryMinH);
  assert.equal(cfg.expiryMaxH, SELLHEDGE_DEFAULTS.expiryMaxH);
  assert.equal(cfg.deltaTarget, SELLHEDGE_DEFAULTS.deltaTarget);
  assert.equal(cfg.bandBtc, SELLHEDGE_DEFAULTS.bandBtc);
  assert.equal(cfg.deltaTol, SELLHEDGE_DEFAULTS.deltaTol);
  // Размер - единственное, чем боевая конфигурация отличается от дефолтов, и это ратифицировано:
  // книги сняты правилом deploy, живая цепочка вооружается автономным стресс-правилом.
  assert.equal(cfg.sizeRule, "stress");
  assert.equal(cfg.stressXPct, 45);
  assert.equal(cfg.stressCapFrac, 0.8);
  assert.equal(SELL_PRESETS[LIVE].calibrated, true);
});

test("вооружение пресетом побитово равно прежней россыпи полей", () => {
  const wasArmed = resolveSellCfg({ sizeRule: "stress" }); // как слал тикет до реестра
  const nowArmed = resolveSellCfg({ presetId: LIVE });
  const { presetId, ...withoutName } = nowArmed;
  assert.equal(presetId, LIVE);
  assert.deepEqual(withoutName, wasArmed, "имя добавилось, ни одно правило не сдвинулось");
});

test("короткий пресет отличается ТОЛЬКО окном срока и честно помечен незамеренным", () => {
  const live = resolveSellCfg({ presetId: LIVE });
  const short = resolveSellCfg({ presetId: SHORT });
  assert.equal(short.expiryMinH, 168);
  assert.equal(short.expiryMaxH, 336);
  assert.equal(SELL_PRESETS[SHORT].calibrated, false, "книг им не снимали, и это должно быть видно");
  const diff = Object.keys(live).filter((k) => live[k] !== short[k]);
  assert.deepEqual(diff.sort(), ["expiryMaxH", "expiryMinH", "presetId"]);
});

test("явное перекрытие побеждает пресет: офлайн-замер меняет одно поле и получает именно его", () => {
  const cfg = resolveSellCfg({ presetId: LIVE, deltaTarget: 0.30, perpFee: 0.0005 });
  assert.equal(cfg.deltaTarget, 0.30);
  assert.equal(cfg.perpFee, 0.0005);
  assert.equal(cfg.expiryMinH, 336, "нетронутые поля пресета остаются пресетными");
  assert.equal(cfg.presetId, LIVE);
});

test("неизвестное имя разрешается в боевой пресет и НАЗЫВАЕТ разрешённый, а не опечатку", () => {
  const cfg = resolveSellCfg({ presetId: "sell-call-нет-такого" });
  assert.deepEqual(cfg, resolveSellCfg({ presetId: LIVE }), "тракт не падает посреди живого тика");
  assert.equal(cfg.presetId, LIVE, "паспорт не должен называть пресет, которого не существует");
  assert.equal(isKnownSellPreset("sell-call-нет-такого"), false, "вооружению есть на что опереться");
  assert.equal(isKnownSellPreset(LIVE), true);
  assert.equal(isKnownSellPreset(null), false);
  assert.equal(isKnownSellPreset(undefined), false);
});

test("паспорт: engineCfg несёт имя пресета и пометку замера, снятую на момент открытия", () => {
  const live = sellhedgeEngineCfg(resolveSellCfg({ presetId: LIVE }));
  assert.equal(live.presetId, LIVE);
  assert.equal(live.presetCalibrated, true);
  const short = sellhedgeEngineCfg(resolveSellCfg({ presetId: SHORT }));
  assert.equal(short.presetId, SHORT);
  assert.equal(short.presetCalibrated, false);
  // Офлайн-тракты пресета не называют: паспорт честно молчит, а не приписывает им боевое имя.
  const offline = sellhedgeEngineCfg(resolveSellCfg());
  assert.equal(offline.presetId, null);
  assert.equal(offline.presetCalibrated, null);
});

// ── Пресет доезжает до строителя ТЕМ ЖЕ путём sellCfg. Фикстура несёт две ноги с одинаковой
// дельтой в РАЗНЫХ окнах срока: боевой пресет обязан выбрать дальнюю, короткий - ближнюю. Если бы
// пресет где-то терялся, обе конфигурации дали бы одну и ту же ногу и тест бы этого не заметил.
const H = 3600000;
const NOW = Date.UTC(2026, 0, 1);
const FAR = NOW + 400 * H; // 400 ч: внутри 336-672, вне 168-336
const NEAR = NOW + 250 * H; // 250 ч: внутри 168-336, вне 336-672
const SPOT = 100000;
const meta = (name, strike, exp) => ({
  instrument_name: name, option_type: "call", strike, expiration_timestamp: exp,
  contract_size: 1, min_trade_amount: 0.01,
});
const legSnap = (mark, delta) => ({
  mark, bid: mark - 10, ask: mark + 10, markIv: 50, delta, vega: 50, theta: -20,
  ts: NOW - 5000, contractSize: 1, minTradeAmount: 0.01, markInUsd: true,
  book: { bidDepthUsd: 20000, askDepthUsd: 20000, tsMs: NOW - 3000 },
});
const CHAIN = { instruments: [meta("FAR-105000-C", 105000, FAR), meta("NEAR-104000-C", 104000, NEAR)] };
const SNAP = { underlying: SPOT, index: SPOT, legs: { "FAR-105000-C": legSnap(2000, 0.45), "NEAR-104000-C": legSnap(1500, 0.45) } };

test("пресет доезжает до buildSellStructure существующим путём sellCfg", () => {
  const far = buildSellStructure({ qty: 0.01, sellCfg: { presetId: LIVE } }, CHAIN, SNAP, NOW);
  const near = buildSellStructure({ qty: 0.01, sellCfg: { presetId: SHORT } }, CHAIN, SNAP, NOW);
  assert.equal(far.error, undefined, far.error);
  assert.equal(near.error, undefined, near.error);
  assert.equal(far.pickedLeg.name, "FAR-105000-C", "боевое окно берёт дальнюю ногу");
  assert.equal(near.pickedLeg.name, "NEAR-104000-C", "короткое окно берёт ближнюю");
});

test("структура, вооружённая пресетом, равна вооружённой россыпью полей", () => {
  const byName = buildSellStructure({ qty: 0.01, sellCfg: { presetId: LIVE } }, CHAIN, SNAP, NOW);
  const byFields = buildSellStructure({ qty: 0.01, sellCfg: { sizeRule: "stress" } }, CHAIN, SNAP, NOW);
  assert.equal(byName.pickedLeg.name, byFields.pickedLeg.name);
  assert.deepEqual(byName.legs, byFields.legs);
  assert.deepEqual(byName.sizing, byFields.sizing);
  assert.deepEqual(byName.costs, byFields.costs);
});
