// fa-margin.test.js - СТОРОЖ ЗАЛОГА ОБЕИХ НОГ (fa/margin.js).
//
// ОРАКУЛ, А НЕ ПЕРЕПРОВЕРКА КОДА СОБОЙ. Поддерживающая маржа Hyperliquid `mm = 1/(2*maxLeverage)`
// сверена в прогоне 10 с полем биржи `crossMaintenanceMarginUsed` до цента, а убивающий ход
// `x* = 1/L - mm` выведен из условия «залог входа стёрт до поддерживающей маржи» на ноционале
// входа. Оба выражения записаны здесь ЧИСЛАМИ, посчитанными руками, а не вызовом модуля.
//
// ЧТО ЭТОТ ТЕСТ НЕ ПРОВЕРЯЕТ И НЕ МОЖЕТ. У бумажного счёта позиции на бирже нет, поэтому настоящей
// цены ликвидации не существует и сверить с ней нечего. Проверяется ВЫРАЖЕНИЕ и его границы, а
// сверка с биржей это прогон 10, и он уже сделан.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FA_GMX_MAINTENANCE_MARGIN, FA_MARGIN_DEFAULTS, FA_MARGIN_LIQ_SOURCE, FA_MARGIN_REFUSALS,
  explainMargin, hlMaintenanceMargin, killMoveFraction, legMargin, marginGuard, positionLegs,
} from "../src/engine/fa/margin.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) < tol, `${label}: получено ${a}, ожидалось ${b} (+/-${tol})`);
const SEEN = new Set();
const watch = (v) => { if (v?.code) SEEN.add(v.code); return v; };

// ─────────────────────────────────────────────────────────────────────────────
// 1. Поддерживающая маржа и убивающий ход
// ─────────────────────────────────────────────────────────────────────────────

test("поддерживающая маржа Hyperliquid берётся ПОЛЕМ биржи, а без поля не выдумывается", () => {
  // Вселенная приложения: BTC maxLev 40, ETH maxLev 25.
  near(hlMaintenanceMargin(40), 0.0125, 1e-12, "BTC");
  near(hlMaintenanceMargin(25), 0.02, 1e-12, "ETH");
  for (const bad of [undefined, null, 0, -5, NaN, "нет"]) {
    assert.equal(hlMaintenanceMargin(bad), null, `${bad}: выдуманное значение опаснее отказа`);
  }
  // Нога GMX: измеренного minCollateralFactor в репозитории нет, поэтому ноль, и это ДОПУЩЕНИЕ.
  assert.equal(FA_GMX_MAINTENANCE_MARGIN, 0);
});

test("убивающий ход это 1/L минус mm, счёт от ноционала ВХОДА", () => {
  near(killMoveFraction(1, 0.0125), 0.9875, 1e-12, "плечо 1, BTC");
  near(killMoveFraction(1, 0.02), 0.98, 1e-12, "плечо 1, ETH");
  near(killMoveFraction(2, 0.0125), 0.4875, 1e-12, "плечо 2, BTC");
  near(killMoveFraction(1, 0), 1, 1e-12, "нога GMX при плече 1 умирает только на нуле цены");
  // Плечо выше предела биржи даёт ОТРИЦАТЕЛЬНЫЙ ход: нога мертва при любом движении.
  assert.ok(killMoveFraction(100, 0.0125) < 0, "плечо 100 при mm 1.25% нежизнеспособно");
  assert.equal(killMoveFraction(0, 0.01), null, "нулевое плечо это не число, а отсутствие позиции");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Одна нога: цена ликвидации и ОСТАВШИЙСЯ запас
// ─────────────────────────────────────────────────────────────────────────────

test("цена ликвидации стоит на ходе x* от цены ВХОДА, в сторону против ноги", () => {
  const long = legMargin({ side: "long", notionalUsd: 2500, leverage: 1, entryPx: 100, markPx: 100, mm: 0.02 });
  near(long.liquidationPx, 2, 1e-9, "длинная нога умирает вниз: 100 * (1 - 0.98)");
  const short = legMargin({ side: "short", notionalUsd: 2500, leverage: 1, entryPx: 100, markPx: 100, mm: 0.02 });
  near(short.liquidationPx, 198, 1e-9, "короткая нога умирает вверх: 100 * (1 + 0.98)");
  // Залог это ноционал, делённый на плечо; при плече 1 они равны.
  near(long.collateralUsd, 2500, 1e-9, "залог при плече 1");
  near(legMargin({ side: "long", notionalUsd: 2500, leverage: 5, entryPx: 100, markPx: 100, mm: 0.02 }).collateralUsd, 500, 1e-9, "залог при плече 5");
  // Ярлык источника у бумажной позиции может быть только модельным.
  assert.equal(long.liqSource, FA_MARGIN_LIQ_SOURCE);
  assert.equal(long.liqSource, "model");
});

test("ЗАПАС СЧИТАЕТСЯ ОТ ТЕКУЩЕЙ ЦЕНЫ, а не от цены входа, иначе сторож молчит там, где нужен", () => {
  // Короткая нога при плече 2: убивающий ход 0.4875, ликвидация на 148.75.
  const at = (markPx) => legMargin({ side: "short", notionalUsd: 2500, leverage: 2, entryPx: 100, markPx, mm: 0.0125 });
  near(at(100).liquidationPx, 148.75, 1e-9, "цена ликвидации не зависит от текущей цены");
  near(at(100).roomFrac, 0.4875, 1e-9, "на входе запас равен полному ходу");
  // Цена ушла против нас на 20%: осталось (148.75 - 120)/120 = 23.96%, а НЕ прежние 48.75%.
  near(at(120).roomFrac, 0.2395833333, 1e-9, "запас съеден движением цены");
  assert.ok(at(160).roomFrac < 0, "за ценой ликвидации запас отрицателен, и это надо видеть");
  // У длинной ноги знак противоположный по построению.
  const l = legMargin({ side: "long", notionalUsd: 2500, leverage: 2, entryPx: 100, markPx: 80, mm: 0.0125 });
  near(l.liquidationPx, 51.25, 1e-9, "длинная при плече 2");
  near(l.roomFrac, (80 - 51.25) / 80, 1e-12, "запас длинной ноги считается вниз");
});

test("нехватка любого входа даёт НЕизвестный запас, а не ноль и не догадку", () => {
  const bad = [
    { side: null, notionalUsd: 2500, leverage: 1, entryPx: 100, markPx: 100, mm: 0 },
    { side: "long", notionalUsd: NaN, leverage: 1, entryPx: 100, markPx: 100, mm: 0 },
    { side: "long", notionalUsd: 2500, leverage: 1, entryPx: null, markPx: 100, mm: 0 },
    { side: "long", notionalUsd: 2500, leverage: 1, entryPx: 100, markPx: null, mm: 0 },
    { side: "long", notionalUsd: 2500, leverage: 1, entryPx: 100, markPx: 100, mm: null },
  ];
  for (const b of bad) {
    const r = legMargin(b);
    assert.equal(r.roomFrac, null, `запас не имеет права появиться из ${JSON.stringify(b)}`);
    assert.equal(r.liquidationPx, null);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Разбор сделки на ноги
// ─────────────────────────────────────────────────────────────────────────────

test("разбор на ноги идёт от legModel леджера: A это шорт GMX, B это лонг GMX, однуногая одна", () => {
  const A = positionLegs({ strategy: "two", config: "A", sizeUsd: 2500, leverage: 1, entryPx: 100, markPx: 100, hlMaxLev: 25 });
  assert.deepEqual(A.map((l) => [l.venue, l.side]), [["gmx", "short"], ["hl", "long"]]);
  const B = positionLegs({ strategy: "two", config: "B", sizeUsd: 2500, leverage: 1, entryPx: 100, markPx: 100, hlMaxLev: 25 });
  assert.deepEqual(B.map((l) => [l.venue, l.side]), [["gmx", "long"], ["hl", "short"]]);
  const one = positionLegs({ strategy: "one", config: null, sizeUsd: 2500, leverage: 1, entryPx: 100, markPx: 100 });
  assert.equal(one.length, 1, "у однуногой схемы биржевой ноги Hyperliquid нет вовсе");
  assert.equal(one[0].venue, "gmx");
  // ОБЕ НОГИ РАВНОГО НОЦИОНАЛА: схема дельта-нейтральна, и разный размер ног это другая схема.
  assert.equal(A[0].notionalUsd, A[1].notionalUsd);
  // Поддерживающая маржа у ног РАЗНАЯ и берётся из своих источников.
  assert.equal(A[0].mm, FA_GMX_MAINTENANCE_MARGIN);
  near(A[1].mm, 0.02, 1e-12, "нога HL по полю биржи");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Сторож: слабейшая нога решает за всю сделку
// ─────────────────────────────────────────────────────────────────────────────

const guardAt = ({ config = "A", leverage = 1, markPx = 100, hlMaxLev = 25, strategy = "two", need = 0.5 }) => watch(marginGuard({
  legs: positionLegs({ strategy, config, sizeUsd: 2500, leverage, entryPx: 100, markPx, hlMaxLev }),
  minRoomFraction: need,
}));

test("при числах владельца (плечо 1, запас 50%) сторож НЕ связывает, и это надо знать", () => {
  assert.equal(FA_MARGIN_DEFAULTS.leverage, 1);
  assert.equal(FA_MARGIN_DEFAULTS.minRoomFraction, 0.5);
  const v = guardAt({});
  assert.equal(v.ok, true);
  assert.equal(v.code, null);
  // Слабейшая это нога Hyperliquid: у неё mm 2%, у ноги GMX ноль по допущению.
  near(v.roomFrac, 0.98, 1e-12, "запас слабейшей ноги при плече 1");
  assert.equal(v.worst.venue, "hl");
  // Порог начинает связывать с плеча 2: 0.5 - 0.0125 = 48.75% меньше требуемых 50%.
  assert.equal(guardAt({ leverage: 2, hlMaxLev: 40 }).ok, false, "плечо 2 при mm 1.25% уже тонко");
});

test("тонкий запас на ДВИЖЕНИИ цены ловится, и это тот эпизод, ради которого сторож заведён", () => {
  // BERA февраля 2026 прошла +127.59%, и короткая нога умирает даже при плече 1. Здесь та же
  // механика в миниатюре: конфигурация A держит КОРОТКУЮ ногу GMX, цена ушла вверх.
  assert.equal(guardAt({ markPx: 100 }).ok, true, "на входе запаса вдоволь");
  const mid = guardAt({ markPx: 140 });
  assert.equal(mid.ok, false, "цена ушла на 40% против короткой ноги: запаса меньше половины");
  assert.equal(mid.code, "margin_thin");
  assert.equal(mid.worst.venue, "gmx", "против ноги GMX идёт рост, и умирает первой она");
  // Ровно на пороге ничья решается В ПОЛЬЗУ ЖИЗНИ: запас, равный требуемому, ещё проходит.
  const exact = marginGuard({ legs: [{ venue: "gmx", side: "long", notionalUsd: 100, leverage: 2, entryPx: 100, markPx: 100, mm: 0 }], minRoomFraction: 0.5 });
  assert.equal(exact.ok, true, "0.5 против 0.5 это не «меньше»");
});

test("неизвестный запас это ОТДЕЛЬНОЕ состояние, а не «в порядке» и не «тонко»", () => {
  // Предельного плеча биржи нет: поддерживающую маржу ноги HL посчитать нечем.
  const v = guardAt({ hlMaxLev: null });
  assert.equal(v.ok, false);
  assert.equal(v.code, "margin_unknown");
  assert.equal(v.roomFrac, null, "число запаса не имеет права появиться при неизвестном входе");
  // Ног нет вовсе: то же состояние, а не молчаливое согласие.
  assert.equal(watch(marginGuard({ legs: [] })).code, "margin_unknown");
  assert.equal(watch(marginGuard({ legs: [{ venue: "gmx", side: "long", notionalUsd: 1, leverage: 1, entryPx: 1, markPx: 1, mm: 0 }], minRoomFraction: NaN })).code, "margin_unknown");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Реестр, журнал и изоляция от бота 2
// ─────────────────────────────────────────────────────────────────────────────

test("каждый код реестра ДОСТИЖИМ, и достижимого вне реестра нет", () => {
  const missing = FA_MARGIN_REFUSALS.filter((c) => !SEEN.has(c));
  assert.deepEqual(missing, [], `коды реестра, которых не получил ни один тест: ${missing.join(", ")}`);
  const extra = [...SEEN].filter((c) => !FA_MARGIN_REFUSALS.includes(c));
  assert.deepEqual(extra, [], `коды вне реестра: ${extra.join(", ")}`);
});

test("журнал объясняет вердикт одной строкой и не падает ни на одной ветке", () => {
  for (const v of [guardAt({}), guardAt({ markPx: 140 }), guardAt({ hlMaxLev: null })]) {
    const line = explainMargin(v);
    assert.ok(line.length > 10, `пустая строка: ${line}`);
    assert.ok(!line.includes("undefined") && !line.includes("NaN"), `дыра в строке: ${line}`);
  }
  assert.equal(explainMargin(null), "сторож залога не считался");
});

test("замыкание импортов сторожа НЕ пересекается с ботом 2", () => {
  // У бота 2 есть СВОЙ margin.js, и он про маржу USDC-опционов Deribit: другой предмет на другой
  // бирже. Общий модуль между ботами это способ уронить второго правкой первого.
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*import[^"']*["'](\.[^"']+)["']/gm)) walk(join(dirname(file), m[1]));
  };
  walk(join(HERE, "..", "src", "engine", "fa", "margin.js"));
  const btc = [...seen].filter((f) => f.includes("btcopt"));
  assert.deepEqual(btc, [], `сторож тянет модули бота 2: ${btc.join(", ")}`);
  assert.ok(seen.size >= 3, "замыкание обязано быть непустым, иначе тест проверяет опечатку в пути");
});

test("в сторожа и в журнал баз нет длинных тире и нет стрелок в прозе", () => {
  for (const f of ["margin.js", "bases.js", "auto.js"]) {
    const src = readFileSync(join(HERE, "..", "src", "engine", "fa", f), "utf8");
    // Глифы записаны escape-последовательностями нарочно: иначе САМ ЭТОТ ФАЙЛ содержал бы то,
    // что запрещает, и проверка не выдержала бы применения к себе.
    assert.equal(src.match(/[\u2014\u2013]/g), null, `${f}: длинных тире быть не должно`);
    assert.equal(src.match(/\u2192/g), null, `${f}: стрелок в прозе быть не должно`);
  }
});
