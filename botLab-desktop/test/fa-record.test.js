// fa-record.test.js - ЖИВАЯ ЗАПИСЬ БОТА 1 (fa/record.js): форма строк, разрядность, реестры кодов,
// непрерывность ленты и посчитанный объём.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ ПАДАЮЩИМ ТЕСТОМ, А НЕ ОБЕЩАНИЕМ. Запись заводится ради трёх вопросов,
// которые сегодня ответить нечем, и у каждого есть поле, без которого архив на него не ответит.
// Поэтому три проверки здесь устроены так, чтобы УПАСТЬ при нарушении правила, а не молча
// пропустить его:
//
//   1. ЗАЛОГ И ЦЕНА ЛИКВИДАЦИИ ОБЕИХ НОГ. Проверяются ДВАЖДЫ и по-разному: раз по составу строки
//      (ключи ноги сверяются со списком целиком, лишний и недостающий ловятся одинаково) и раз по
//      реестру `FA_SNAP_LEG_FIELDS` по именам. Одной проверки мало: удалив поле из строителя,
//      «починить» первую можно правкой реестра, и тогда архив тихо потерял бы предмет.
//   2. ПРОПУСК БЕЗ КОДА. Лента с дырой, не объяснённой строкой пропуска, обязана давать непустой
//      `unexplained`. Проверяется в обе стороны: та же лента со строкой пропуска даёт пустой.
//   3. ОБЪЁМ. `FA_RECORD_SIZE` сверяется с ДЛИНОЙ НАСТОЯЩИХ СТРОК, поэтому добавленное поле
//      роняет тест и заставляет обновить таблицу мегабайтов в шапке модуля, а не забыть про неё.
//
// РЕЕСТРЫ ПРОВЕРЯЮТСЯ НА ДОСТИЖИМОСТЬ И НА НЕПЕРЕСЕЧЕНИЕ. Достижимость: реестр, кода которого не
// получил ни один тест, это обещание. Непересечение: словари снимка и словари отказов правил
// описывают РАЗНЫЕ предметы (наблюдения против решений), и одинаковая строка в двух смыслах
// сделала бы чтение архива двусмысленным.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FA_SIZING_REFUSALS, FA_SIZING_BINDINGS, FA_SIZING_DEFAULTS } from "../src/engine/fa/sizing.js";
import { FA_EXIT_REASONS } from "../src/engine/fa/exit.js";
import {
  FA_GAP_CAUSES, FA_GAP_SLOTS, FA_LIQ_SOURCES, FA_POS_MISSING, FA_RECORD_KINDS, FA_RECORD_PREFIX,
  FA_RECORD_SIZE, FA_RECORD_SOURCES, FA_RECORD_VERSION, FA_SNAP_LEG_FIELDS, FA_SNAP_MISSING,
  FA_TRADE_EVENTS,
  buildFaDecisionRecord, buildFaGapRecord, buildFaSnapRecord, buildFaTradeRecord,
  classifyFaGap, faCoverage, faDecisionsFromRecords, faHeldRank, faLiqRoom, faRecordDayKey,
  faRecordsToPrune, faTradesFromRecords, faUnknownCodes, faVanishedMarkets, faVolumePerDay,
} from "../src/engine/fa/record.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const T0 = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const MIN = 60_000;
const bytes = (row) => JSON.stringify(row).length + 1; // строка NDJSON плюс перевод строки

// Достижимость реестров копится тестами и сверяется в конце файла.
const SEEN_MISS = new Set();
const SEEN_POS = new Set();
const SEEN_GAP = new Set();
const SEEN_KIND = new Set();
const SEEN_EV = new Set();
const SEEN_LIQ = new Set();
const SEEN_SRC = new Set();

const note = (row) => {
  if (!row) return row;
  SEEN_KIND.add(row.k);
  if (row.s) SEEN_SRC.add(row.s);
  if (row.k === "gap") SEEN_GAP.add(row.c);
  if (row.k === "trade") SEEN_EV.add(row.ev);
  for (const c of row.x || []) SEEN_MISS.add(c);
  for (const c of row.xp || []) SEEN_POS.add(c);
  for (const cell of Object.values(row.m || {})) for (const c of cell.x || []) SEEN_MISS.add(c);
  for (const leg of [row.p?.g, row.p?.h, row.pos?.g, row.pos?.h, row.prev?.g, row.prev?.h]) {
    if (leg?.ls) SEEN_LIQ.add(leg.ls);
  }
  return row;
};

// ── Конструкторы входа. Числа взяты «неровными» нарочно: ровное число не показало бы, где
// разрядность режет, а где нет.
const market = (token, over = {}) => ({
  token, chain: "arbitrum", gateOk: true,
  factors: { f_long: -1.2345678901234e-9, f_short: 1.2345678901234e-9, b_long: 3.456789e-10, b_short: 2.345678e-10 },
  hlRate: 0.0000125, hlPremium: 0.0000031,
  fbaseLongUsd: 12345678.9012, fbaseShortUsd: 9876543.2109,
  availLongUsd: 1234567.89, availShortUsd: 2345678.9,
  markPx: 112345.6, oraclePx: 112344.9, maxLev: 40,
  bookAgeSec: 0.544,
  book: {
    visibleNtl: 4567890.12, exhaustedFrom: null,
    nodes: [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000].map((s, i) => ({ sizeUsd: s, bps: 0.2 + i * 0.31 })),
  },
  ...over,
});

const leg = (over = {}) => ({
  notionalUsd: 2500, collateralUsd: 2500, markPx: 112344.9,
  liquidationPx: 219876.54, liqSource: "model", ...over,
});

const position = (over = {}) => ({
  token: "BTC", config: "A", strategy: "two",
  gmx: leg(), hl: leg({ markPx: 112345.6, liquidationPx: 56789.01, liqSource: "venue" }),
  ...over,
});

const snap = (over = {}) => note(buildFaSnapRecord({
  t: T0, source: "live", gmxAgeSec: 2.1, hlAgeSec: 1.8,
  markets: [market("BTC")], position: position(), ...over,
}));

const curve = (token, over = {}) => ({
  token, config: "A", sizeUsd: 1995.2623, starUsd: 3162.2776, netUsd: 12.3456, grossUsd: 18.7654,
  costUsd: 7.1987, ratio: 1.71499, ratioAtStar: 1.6423, ceilingUsd: 25528.44, binding: "dilution",
  flowWeightedBaseUsd: 6789.01, dilutionRetained: 0.995123, refusal: null, ...over,
});

const universe = (funded = [], refused = []) => ({
  curves: [...funded, ...refused],
  refusals: refused.map((r) => ({ token: r.token, config: r.config, refusal: r.refusal })),
  alloc: new Map(funded.map((c) => [c.token, c.sizeUsd])),
  usedUsd: 4990.12, netTotal: 31.24, cfg: { ...FA_SIZING_DEFAULTS },
});

const exitOf = (over = {}) => ({
  action: "hold", reason: "hold_best", holdGrossUsd: 18.7654, switchNetUsd: 12.3456, gainUsd: -6.4198,
  best: { token: "ALT", config: "A", sizeUsd: 1995.2623, netUsd: 12.3456 }, ...over,
});

// Ворота снабжения тика: покрытие лучшего рынка с разбивкой по происхождению (живьём, долито, без метки).
const gateOf = (over = {}) => ({
  markets: 5, usable: 3, covBestH: 705, covNeedH: 684, covLiveH: 300, covIndexerH: 400, covUnknownH: 5, ...over,
});

const decision = (over = {}) => note(buildFaDecisionRecord({
  t: T0, source: "live", ageSec: 2.1, capitalUsd: 5000, presetId: "fa-per-market-h720-v1",
  cfg: { ...FA_SIZING_DEFAULTS }, universe: universe([curve("BTC")]), exit: exitOf(), hold: "BTC",
  window: { firstTsHour: 1_697_400_000, lastTsHour: 1_699_992_000, rows: 720 }, ...over,
}));

const tradeSide = (token, over = {}) => ({
  token, config: "A", strategy: "two", wantUsd: 2500, gotUsd: 1995.26, leverage: 1,
  gmx: leg({ notionalUsd: 1995.26, collateralUsd: 1995.26 }),
  hl: leg({ notionalUsd: 1995.26, collateralUsd: 1995.26, markPx: 112345.6, liquidationPx: 56789.01, liqSource: "venue" }),
  ...over,
});

const COSTS = { gmxOpenUsd: 1.19716, gmxCloseUsd: 1.19716, gmxImpactUsd: 1.99526, gmxGasUsd: 1, hlTakerUsd: 1.79573 };

// ─────────────────────────────────────────────────────────────────────────────
// 1. Снимок рынка: сырьё бирж до всякой обработки
// ─────────────────────────────────────────────────────────────────────────────

test("снимок: ставки, борроу, ставка и премия Hyperliquid едут в строку как наблюдения", () => {
  const row = snap();
  assert.equal(row.v, FA_RECORD_VERSION);
  assert.equal(row.k, "snap");
  assert.equal(row.t, T0);
  const m = row.m.BTC;
  assert.equal(m.fs, 1.23456789012e-9, "посекундный фактор: 12 значащих цифр");
  assert.equal(m.fl, -1.23456789012e-9);
  assert.equal(m.bl, 3.456789e-10);
  assert.equal(m.bs, 2.345678e-10);
  assert.equal(m.hr, 0.0000125, "часовая ставка Hyperliquid");
  assert.equal(m.hp, 0.0000031, "премия Hyperliquid");
  assert.equal(m.gt, 1, "тождество netRate = funding + borrow сошлось");
  assert.equal(m.c, "arbitrum", "цепочка рынка: у одного токена рынки на разных цепочках разные");
  assert.deepEqual(row.x, undefined, "полный снимок не несёт кодов пропуска");
});

test("снимок: БАЗЫ ФАНДИНГА ОБЕИХ СТОРОН лежат отдельным полем, а не внутри кадра", () => {
  // Без баз правило входа отказывает КАЖДОМУ рынку кодом no_base, поэтому запись обязана нести их
  // сама, а не полагаться на то, что кадр трейлинга их донесёт.
  const m = snap().m.BTC;
  assert.equal(m.bL, 12345678.9, "база длинной стороны, огрублена до цента");
  assert.equal(m.bS, 9876543.21, "база короткой стороны");
  assert.ok(m.bL !== m.bS, "стороны различимы: одно число на обе стороны потеряло бы отношение B/(B+S)");
});

test("снимок: место в стакане и ёмкость на момент снимка, включая точку исчерпания", () => {
  const m = snap().m.BTC;
  assert.equal(m.bk.v, 4567890.12, "видимый ноционал меньшей стороны");
  assert.equal(m.bk.x, null, "стакан не кончился ни на одном измеренном узле");
  assert.equal(m.bk.n.length, 8, "восемь узлов кривой круга, столько же, сколько потребляет правило");
  assert.deepEqual(m.bk.n[0], [1000, 0.2]);
  assert.deepEqual(m.bk.n[7], [500000, 2.37]);
  assert.equal(m.bk.a, 0.5, "СОБСТВЕННЫЙ возраст стакана: он тянется отдельным запросом на рынок");
  const ex = note(snap({ markets: [market("BTC", { book: { visibleNtl: 1000, exhaustedFrom: 25000, nodes: [{ sizeUsd: 1000, bps: 0.2 }] } })] }));
  assert.equal(ex.m.BTC.bk.x, 25000, "исчерпание стакана это наблюдение, а не отсутствие узлов");
  assert.equal(ex.m.BTC.bk.n.length, 1);
});

test("снимок: свободная ликвидность GMX обеих сторон и цены обеих площадок", () => {
  const m = snap().m.BTC;
  assert.equal(m.aL, 1234567.89);
  assert.equal(m.aS, 2345678.9);
  assert.equal(m.mk, 112345.6, "марк Hyperliquid пишется КАК ПРИШЁЛ, без огрубления");
  assert.equal(m.op, 112344.9, "оракульная цена отдельно от марка: расхождение площадок наблюдаемо");
  assert.equal(m.ml, 40);
});

test("снимок: возраст данных ОБОИХ источников, потому что стареют они независимо", () => {
  const row = snap({ gmxAgeSec: 2.13, hlAgeSec: 1804.77 });
  assert.equal(row.ga, 2.1);
  assert.equal(row.ha, 1804.8, "получасовой Hyperliquid при свежем GMX это НЕ срез возрастом полчаса");
  const none = note(snap({ gmxAgeSec: undefined, hlAgeSec: undefined }));
  assert.deepEqual(none.x, ["age"], "свежесть не установлена вовсе: это событие, а не два null");
});

test("снимок: ярлык источника отличает живой опрос от протяжки архива", () => {
  assert.equal(snap().s, "live");
  assert.equal(note(snap({ source: "replay" })).s, "replay");
  assert.equal(note(snap({ source: "smoke" })).s, "smoke");
  assert.equal(note(snap({ source: "выдумка" })).s, "live", "неизвестный ярлык не пишется как есть");
});

test("снимок без метки времени не пишется вовсе", () => {
  assert.equal(buildFaSnapRecord({ markets: [market("BTC")] }), null);
  assert.equal(buildFaSnapRecord({}), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ЗАЛОГ И ЦЕНА ЛИКВИДАЦИИ ОБЕИХ НОГ. Ради этого вопроса запись и заводится
// ─────────────────────────────────────────────────────────────────────────────

test("снимок с открытой позицией несёт ЗАЛОГ и ЦЕНУ ЛИКВИДАЦИИ КАЖДОЙ ноги", () => {
  // Проверка по СОСТАВУ, а не по наличию: недостающее и лишнее поле ловятся одинаково, поэтому
  // удаление залога из строителя роняет этот тест, а не проходит мимо него.
  const row = snap();
  assert.deepEqual(Object.keys(row.p.g), [...FA_SNAP_LEG_FIELDS], "нога GMX: состав полей закреплён");
  assert.deepEqual(Object.keys(row.p.h), [...FA_SNAP_LEG_FIELDS], "нога Hyperliquid: тот же состав");
  assert.equal(row.p.g.col, 2500, "залог ноги GMX");
  assert.equal(row.p.h.col, 2500, "залог ноги Hyperliquid");
  assert.equal(row.p.g.liq, 219876.54, "цена ликвидации ноги GMX");
  assert.equal(row.p.h.liq, 56789.01, "цена ликвидации ноги Hyperliquid");
  assert.equal(row.p.g.ntl, 2500, "ноционал рядом с залогом: без него плечо неизвестно");
  assert.equal(row.p.g.px, 112344.9, "цена ноги рядом с ликвидацией: без неё запас нечем мерить");
  assert.equal(row.p.t, "BTC");
  assert.equal(row.p.c, "A");
  assert.equal(row.p.st, "two");
});

test("реестр полей ноги ОБЯЗАН содержать залог и цену ликвидации", () => {
  // Вторая проверка того же требования, нарочно другим способом. Первую можно «починить» правкой
  // реестра, эту нельзя: здесь имена названы буквально.
  assert.ok(FA_SNAP_LEG_FIELDS.includes("col"), "залог ноги: без него архив не ответит про ликвидацию");
  assert.ok(FA_SNAP_LEG_FIELDS.includes("liq"), "цена ликвидации ноги");
  assert.ok(FA_SNAP_LEG_FIELDS.includes("px"), "цена ноги: ликвидация без неё бессмысленна");
  assert.ok(FA_SNAP_LEG_FIELDS.includes("ntl"), "ноционал ноги");
  assert.ok(FA_SNAP_LEG_FIELDS.includes("ls"), "ярлык источника цены ликвидации");
});

test("цена ликвидации несёт ЯРЛЫК ИСТОЧНИКА: биржа и модель это разные основания", () => {
  const row = snap();
  assert.equal(row.p.h.ls, "venue", "число биржи (clearinghouseState живого счёта)");
  assert.equal(row.p.g.ls, "model", "число модели маржи вызывающего");
  const bad = note(snap({ position: position({ gmx: leg({ liqSource: "прикинули" }) }) }));
  assert.equal(bad.p.g.ls, null, "неизвестный ярлык не пишется как есть");
  assert.ok(bad.xp.includes("leg_liq_src"), "ликвидация без ярлыка это НАЗВАННЫЙ пропуск");
});

test("пропущенный залог или ликвидация не проглатываются: каждый называется своим кодом", () => {
  const noCol = note(snap({ position: position({ gmx: leg({ collateralUsd: undefined }) }) }));
  assert.equal(noCol.p.g.col, null);
  assert.ok(noCol.xp.includes("leg_collateral"));
  const noLiq = note(snap({ position: position({ hl: leg({ liquidationPx: undefined, liqSource: "venue" }) }) }));
  assert.ok(noLiq.xp.includes("leg_liq"));
  const noPx = note(snap({ position: position({ hl: leg({ markPx: undefined }) }) }));
  assert.ok(noPx.xp.includes("leg_mark"));
  const noNtl = note(snap({ position: position({ gmx: leg({ notionalUsd: undefined }) }) }));
  assert.ok(noNtl.xp.includes("leg_notional"));
});

test("сделки нет: блок позиции пуст, и это НЕ пропуск наблюдения", () => {
  const row = note(snap({ position: null }));
  assert.equal(row.p, null);
  assert.equal(row.xp, undefined, "нет ног - нет и кодов про ноги: иначе плоский бот кричал бы всегда");
});

test("запас до ликвидации СЧИТАЕТСЯ из записанного сырья, а не хранится полем", () => {
  const r = faLiqRoom(snap());
  assert.ok(Math.abs(r.gmx - (219876.54 / 112344.9 - 1)) < 1e-12, "нога GMX: ход вверх до смерти короткой");
  assert.ok(Math.abs(r.hl - (1 - 56789.01 / 112345.6)) < 1e-12, "нога Hyperliquid: ход вниз");
  assert.deepEqual(r.src, { gmx: "model", hl: "venue" }, "запас наследует основание своей ликвидации");
  assert.equal(faLiqRoom(snap({ position: null })), null);
  const half = faLiqRoom(snap({ position: position({ gmx: leg({ liquidationPx: undefined }) }) }));
  assert.equal(half.gmx, null, "нечем считать - null, а не выдуманное число");
  assert.ok(half.hl > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Пропуски наблюдений по рынку
// ─────────────────────────────────────────────────────────────────────────────

test("отсутствие каждой части рыночного наблюдения называется своим кодом", () => {
  const noRates = note(snap({ markets: [market("BTC", { factors: null })] }));
  assert.ok(noRates.m.BTC.x.includes("gmx_rates"));
  const noBase = note(snap({ markets: [market("BTC", { fbaseLongUsd: undefined })] }));
  assert.ok(noBase.m.BTC.x.includes("gmx_base"), "без баз правило входа откажет кодом no_base");
  const noAvail = note(snap({ markets: [market("BTC", { availShortUsd: undefined })] }));
  assert.ok(noAvail.m.BTC.x.includes("gmx_avail"));
  const noHl = note(snap({ markets: [market("BTC", { hlRate: undefined })] }));
  assert.ok(noHl.m.BTC.x.includes("hl_ctx"));
  const noBook = note(snap({ markets: [market("BTC", { book: null })] }));
  assert.ok(noBook.m.BTC.x.includes("hl_book"), "стакана нет: проскальзывание НЕИЗВЕСТНО");
  assert.equal(noBook.m.BTC.bk, null);
  const noAge = note(snap({ markets: [market("BTC", { bookAgeSec: undefined })] }));
  assert.ok(noAge.m.BTC.x.includes("age"), "стакан без своего возраста: свежесть не установлена");
});

test("рынок без имени в строку не попадает, а рынок с именем попадает всегда", () => {
  const row = note(snap({ markets: [market("BTC"), { chain: "arbitrum" }, market("ETH")] }));
  assert.deepEqual(Object.keys(row.m).sort(), ["BTC", "ETH"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ПРОПУСК ОПРОСА: событие, а не отсутствие строки
// ─────────────────────────────────────────────────────────────────────────────

test("перерыв ниже порога это дрожание таймера, а не пропуск", () => {
  assert.equal(buildFaGapRecord({ fromMs: T0, toMs: T0 + 4 * 5 * MIN, nominalSec: 300 }), null);
  assert.equal(buildFaGapRecord({ fromMs: T0, toMs: T0 + FA_GAP_SLOTS * 5 * MIN, nominalSec: 300 }), null,
    "ровно порог это ещё не перерыв: строгий знак отдаёт ничью молчанию таймера");
  assert.ok(buildFaGapRecord({ fromMs: T0, toMs: T0 + 6 * 5 * MIN, nominalSec: 300 }));
});

test("час без данных пишется строкой со СЧЁТОМ потерянных слотов и причиной", () => {
  const row = note(buildFaGapRecord({ fromMs: T0, toMs: T0 + 60 * MIN, nominalSec: 300, hints: { bootAt: T0 + 30 * MIN } }));
  assert.equal(row.k, "gap");
  assert.equal(row.t, T0 + 60 * MIN, "метка строки это КОНЕЦ перерыва: там, где опрос возобновился");
  assert.equal(row.f, T0);
  assert.equal(row.ms, 60 * MIN);
  assert.equal(row.nom, 300);
  assert.equal(row.lost, 11, "час при опросе раз в 5 минут это 12 слотов, потеряно 11");
  assert.equal(row.c, "app-down");
});

test("причина перерыва НЕ ВЫДУМЫВАЕТСЯ: не покрыл ни один хинт - значит unknown", () => {
  const g = (hints) => classifyFaGap({ fromMs: T0, toMs: T0 + 60 * MIN, hints });
  assert.equal(g({ sleepWindow: { start: T0 + 10 * MIN, end: T0 + 40 * MIN } }), "sleep");
  assert.equal(g({ bootAt: T0 + 30 * MIN }), "app-down");
  assert.equal(g({ sourceErrorSince: T0 + 5 * MIN }), "no-response");
  assert.equal(g({}), "unknown");
  assert.equal(g({ bootAt: T0 - MIN }), "unknown", "бут ВНЕ перерыва его не объясняет");
  // Порядок проверки это точность сигнала: точное окно сна старше метки бута, метка бута старше
  // молчания источника.
  assert.equal(g({ sleepWindow: { start: T0, end: T0 + MIN }, bootAt: T0 + 30 * MIN, sourceErrorSince: T0 }), "sleep");
  assert.equal(g({ bootAt: T0 + 30 * MIN, sourceErrorSince: T0 }), "app-down");
  // ВЫКЛЮЧЕННЫЙ АВТОМАТ ПЕРЕБИВАЕТ ВСЁ: он причина достаточная, а не одно из наблюдений. Пока
  // причины не было, собственный останов оператора уходил в `unexplained` наравне с потерей связи
  // (замер: 9 минут выключенного бота дали 540 с необъяснённого перерыва и покрытие 42.9%).
  assert.equal(g({ offWindow: { start: T0, end: T0 + 30 * MIN } }), "off");
  assert.equal(g({ offWindow: { start: T0, end: T0 + 30 * MIN }, sleepWindow: { start: T0, end: T0 + MIN },
    bootAt: T0 + 30 * MIN, sourceErrorSince: T0 }), "off", "останов известен точнее, чем сон и молчание");
  assert.equal(g({ offWindow: { start: T0 - 90 * MIN, end: T0 - 30 * MIN } }), "unknown",
    "окно останова ВНЕ перерыва его не объясняет");
  assert.equal(g({ offWindow: { start: T0, end: null } }), "unknown", "полуоткрытое окно не объясняет ничего");
  for (const c of FA_GAP_CAUSES) SEEN_GAP.add(c);
});

test("перерыв без номинального интервала не пишется: потерянные слоты нечем считать", () => {
  assert.equal(buildFaGapRecord({ fromMs: T0, toMs: T0 + 60 * MIN }), null);
  assert.equal(buildFaGapRecord({ fromMs: T0, toMs: T0 - MIN, nominalSec: 300 }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. НЕПРЕРЫВНОСТЬ ЛЕНТЫ. Пропуск часа БЕЗ КОДА обязан ронять проверку
// ─────────────────────────────────────────────────────────────────────────────

const tape = (offsetsMin) => offsetsMin.map((k) => buildFaSnapRecord({
  t: T0 + k * MIN, gmxAgeSec: 1, hlAgeSec: 1, markets: [market("BTC")], position: null,
}));

test("дыра в ленте БЕЗ строки пропуска попадает в unexplained", () => {
  // Час молчания между 5-й и 65-й минутой при опросе раз в 5 минут.
  const rows = tape([0, 5, 65, 70]);
  const cov = faCoverage(rows, { nominalSec: 300 });
  assert.equal(cov.unexplained.length, 1, "молчаливая дыра обязана быть НАЗВАНА, а не пропущена");
  assert.equal(cov.unexplained[0].from, T0 + 5 * MIN);
  assert.equal(cov.unexplained[0].to, T0 + 65 * MIN);
  assert.equal(cov.unexplained[0].ms, 60 * MIN);
  assert.deepEqual(cov.explained, []);
});

test("та же лента со строкой пропуска: unexplained пуст, причина названа", () => {
  const rows = [...tape([0, 5, 65, 70]), buildFaGapRecord({
    fromMs: T0 + 5 * MIN, toMs: T0 + 65 * MIN, nominalSec: 300, hints: { sleepWindow: { start: T0 + 6 * MIN, end: T0 + 64 * MIN } },
  })];
  const cov = faCoverage(rows, { nominalSec: 300 });
  assert.deepEqual(cov.unexplained, [], "перерыв объяснён строкой");
  assert.equal(cov.explained.length, 1);
  assert.equal(cov.explained[0].cause, "sleep");
  assert.deepEqual(cov.byCause, { sleep: 1 });
  assert.equal(cov.lostSlots, 11);
});

test("покрытие считается включительно по обоим концам, иначе выходят проценты выше ста", () => {
  const cov = faCoverage(tape([0, 5, 10]), { nominalSec: 300 });
  assert.equal(cov.polls, 3);
  assert.equal(cov.expected, 3, "span/шаг + 1, а не span/шаг");
  assert.equal(cov.coveragePct, 100);
  const holed = faCoverage(tape([0, 5, 65]), { nominalSec: 300 });
  assert.equal(holed.expected, 14);
  assert.ok(holed.coveragePct < 25);
});

test("покрытие без номинального интервала или без снимков не выдумывает числа", () => {
  assert.equal(faCoverage(tape([0, 5]), {}).coveragePct, null);
  assert.equal(faCoverage([], { nominalSec: 300 }).polls, 0);
  assert.equal(faCoverage(null, { nominalSec: 300 }).coveragePct, null);
});

test("исчезнувший рынок виден счётом: наблюдался и перестал наблюдаться", () => {
  const rows = [
    buildFaSnapRecord({ t: T0, gmxAgeSec: 1, hlAgeSec: 1, markets: [market("BTC"), market("DEAD")] }),
    buildFaSnapRecord({ t: T0 + 5 * MIN, gmxAgeSec: 1, hlAgeSec: 1, markets: [market("BTC")] }),
  ];
  assert.deepEqual(faVanishedMarkets(rows), ["DEAD"]);
  assert.deepEqual(faVanishedMarkets(rows.slice(0, 1)), [], "одной строки мало для суждения");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Расчёт решения: из чего решали, а не что решили
// ─────────────────────────────────────────────────────────────────────────────

test("решение несёт ВОЗРАСТ ДАННЫХ, потолок капитала, пресет и окно трейлинга", () => {
  const row = decision();
  assert.equal(row.k, "dec");
  assert.equal(row.age, 2.1, "без возраста нельзя отличить плохое решение от решения по протухшим данным");
  assert.equal(row.cap, 5000);
  assert.equal(row.pre, "fa-per-market-h720-v1");
  assert.equal(row.hz, 720, "горизонт: ответ правила целиком определяется им");
  assert.deepEqual(row.hw, [1_697_400_000, 1_699_992_000, 720], "какие ИМЕННО часы участвовали");
  assert.deepEqual(row.cfgd, {}, "боевая конфигурация: отличий от значений по умолчанию нет");
});

test("отличия конфигурации пишутся РАЗНИЦЕЙ, а не целым блоком в каждой строке", () => {
  const row = note(buildFaDecisionRecord({
    t: T0, ageSec: 1, capitalUsd: 5000, universe: universe([curve("BTC")]),
    cfg: { ...FA_SIZING_DEFAULTS, shrinkToUniform: 1, ticketCapUsd: Infinity },
  }));
  assert.deepEqual(row.cfgd, { shrinkToUniform: 1, ticketCapUsd: "inf" },
    "бесконечность в JSON это null, поэтому она пишется словом, а не теряется");
});

test("решение несёт кривые профинансированных рынков со ВСЕМИ числами отбора", () => {
  const c = decision().mk[0];
  assert.equal(c.t, "BTC");
  assert.equal(c.c, "A");
  assert.equal(c.s, 1995.26, "размер, которым входим");
  assert.equal(c.st, 3162.28, "внутренний оптимум ДО потолков");
  assert.ok(c.s !== c.st, "расхождение размера с оптимумом и есть цена потолка, и её надо видеть");
  assert.equal(c.n, 12.35);
  assert.equal(c.g, 18.77);
  assert.equal(c.k, 7.2, "круг издержек при ЭТОМ размере");
  assert.equal(c.r, 1.71499, "отношение нетто к кругу при торгуемом размере");
  assert.equal(c.rs, 1.6423, "и при оптимуме: оно для разбора, а не для решения");
  assert.equal(c.b, "dilution", "что СВЯЗАЛО размер");
  assert.equal(c.cl, 25528.44);
  assert.equal(c.wb, 6789.01, "взвешенная потоком база");
  assert.equal(c.dr, 0.995123, "какую долю потока удержим после собственного разбавления");
});

test("решение несёт ВСЕ коды отказа, а не только решивший", () => {
  const row = note(buildFaDecisionRecord({
    t: T0, ageSec: 1, capitalUsd: 5000, cfg: { ...FA_SIZING_DEFAULTS },
    universe: universe([curve("BTC")], [
      { token: "MEME", config: "A", refusal: "decreasing_at_every_size" },
      { token: "ANIME", config: "B", refusal: "below_fund_ratio" },
      { token: "FET", config: "A", refusal: "no_capital_left" },
    ]),
  }));
  assert.equal(row.rf.length, 3);
  assert.deepEqual(row.rf.map((r) => r.x).sort(),
    ["below_fund_ratio", "decreasing_at_every_size", "no_capital_left"]);
  assert.deepEqual(row.rf.find((r) => r.t === "ANIME"), { t: "ANIME", c: "B", x: "below_fund_ratio" });
  assert.equal(row.mk.length, 1, "профинансированные и отказанные лежат раздельно и не дублируются");
  assert.deepEqual(faUnknownCodes(row), [], "все коды из существующего реестра входа");
});

test("код ОТКАЗА вне реестра не проглатывается молча: он виден полем xc", () => {
  const row = note(buildFaDecisionRecord({
    t: T0, ageSec: 1, capitalUsd: 5000, cfg: { ...FA_SIZING_DEFAULTS },
    universe: universe([], [{ token: "X", config: "A", refusal: "придумали_на_месте" }]),
  }));
  assert.deepEqual(row.xc, ["refuse:придумали_на_месте"]);
  assert.deepEqual(faUnknownCodes(row), ["refuse:придумали_на_месте"]);
  assert.equal(row.rf[0].x, "придумали_на_месте", "сам код всё равно записан: терять наблюдение нельзя");
});

test("связывающее вне реестра и исход выхода вне реестра тоже видны полем xc", () => {
  const bind = note(buildFaDecisionRecord({
    t: T0, ageSec: 1, capitalUsd: 5000, cfg: { ...FA_SIZING_DEFAULTS },
    universe: universe([curve("BTC", { binding: "новое_ограничение" })]),
  }));
  assert.deepEqual(bind.xc, ["bind:новое_ограничение"]);
  const ex = note(buildFaDecisionRecord({
    t: T0, ageSec: 1, capitalUsd: 5000, cfg: { ...FA_SIZING_DEFAULTS }, universe: universe([]),
    exit: exitOf({ action: "думаем", reason: "потому_что" }),
  }));
  assert.deepEqual(ex.xc, ["act:думаем", "exit:потому_что"]);
});

test("решение выхода едет целиком: исход, причина, брутто удержания и нетто альтернативы", () => {
  const e = decision().ex;
  assert.equal(e.a, "hold");
  assert.equal(e.w, "hold_best");
  assert.equal(e.hg, 18.77, "БРУТТО удержания: в этой ветке круг не платится");
  assert.equal(e.sn, 12.35, "НЕТТО альтернативы: в той ветке платится");
  assert.equal(e.gn, -6.42, "прибавка печатается и отрицательной: это другое состояние, чем её отсутствие");
  assert.equal(e.bt, "ALT");
  assert.equal(e.bs, 1995.26);
  assert.equal(decision({ exit: null }).ex, null, "открытой сделки нет - блока выхода нет");
});

test("РАНГ занятой позиции СЧИТАЕТСЯ из списка, а не пишется числом", () => {
  const row = note(buildFaDecisionRecord({
    t: T0, ageSec: 1, capitalUsd: 5000, cfg: { ...FA_SIZING_DEFAULTS }, hold: "MID",
    universe: universe([
      curve("TOP", { netUsd: 30 }), curve("MID", { netUsd: 20 }), curve("LOW", { netUsd: 10 }),
    ]),
  }));
  assert.equal(faHeldRank(row), 2, "критерий выхода срабатывает в 60.7% решений именно на ранге 2");
  assert.equal(faHeldRank({ ...row, hold: "TOP" }), 1, "вершина это неподвижная точка критерия");
  assert.equal(faHeldRank({ ...row, hold: "OUT" }), null,
    "позиция ВЫПАЛА из годных: это другое состояние, чем плохой ранг, и не ноль");
  assert.equal(faHeldRank({ ...row, hold: null }), null);
  assert.equal(faHeldRank(null), null);
});

test("решение без метки времени не пишется вовсе", () => {
  assert.equal(buildFaDecisionRecord({ universe: universe([curve("BTC")]) }), null);
  assert.equal(buildFaDecisionRecord({}), null);
});

test("решение несёт ворота снабжения с разбивкой покрытия по происхождению", () => {
  // РЕШЕНИЕ ВЛАДЕЛЬЦА 2026-09-02: часы окна без наблюдения доливаются историей индексатора. Задним
  // числом надо уметь отличить решение на наблюдённых базах от решения на долитых: это разные
  // наблюдения, и объект ворот раньше в запись не ехал вовсе.
  const row = decision({ gate: gateOf() });
  assert.deepEqual(row.gt, { m: 5, u: 3, cb: 705, cn: 684, cl: 300, ci: 400, cu: 5 });
  assert.equal(decision().gt, null, "без ворот блока нет, а не нули");
  // Рынки короче горизонта: покрытия нет, и null остаётся null, а не превращается в ноль.
  const empty = decision({ gate: gateOf({ usable: 0, covBestH: null, covLiveH: null, covIndexerH: null, covUnknownH: null }) });
  assert.deepEqual(empty.gt, { m: 5, u: 0, cb: null, cn: 684, cl: null, ci: null, cu: null });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. История сделок: полный паспорт
// ─────────────────────────────────────────────────────────────────────────────

test("паспорт входа: ОБА размера, обе ноги с залогом и ликвидацией, издержки по статьям", () => {
  const row = note(buildFaTradeRecord({
    t: T0, event: "open", ageSec: 2.1, decisionAt: T0 - 1000,
    opened: tradeSide("BTC"), costs: COSTS,
  }));
  assert.equal(row.k, "trade");
  assert.equal(row.ev, "open");
  assert.equal(row.why, null, "у входа причина живёт в строке решения, на которую указывает d");
  assert.equal(row.d, T0 - 1000, "паспорт пришит к расчёту, из которого вырос");
  assert.equal(row.age, 2.1);
  assert.equal(row.pos.want, 2500, "ЗАЯВЛЕННЫЙ размер");
  assert.equal(row.pos.got, 1995.26, "ФАКТИЧЕСКИ размещённый: капитал округляется вниз до узла сетки");
  assert.ok(row.pos.want !== row.pos.got, "простаивает 20.2%, и одно число этого не показывает");
  assert.equal(row.pos.lev, 1);
  assert.deepEqual(Object.keys(row.pos.g), [...FA_SNAP_LEG_FIELDS]);
  assert.equal(row.pos.g.col, 1995.26);
  assert.equal(row.pos.h.liq, 56789.01);
  assert.deepEqual(row.cost, { o: 1.2, cl: 1.2, i: 2, gas: 1, hl: 1.8 },
    "статьи раздельно: круг скаляром не даёт разобрать, что подорожало");
  assert.equal(row.prev, null);
});

test("одноногая схема: ноги Hyperliquid НЕ СУЩЕСТВУЕТ, и это не пропуск наблюдения", () => {
  // Автомат входит одной ногой чаще, чем двумя. Пока блок ноги строился на обе стороны безусловно,
  // каждый паспорт и каждый снимок одноногой сделки нёс четыре кода `leg_*`: канал честности горел
  // на всех записях подряд и переставал значить хоть что-нибудь.
  const row = note(buildFaTradeRecord({
    t: T0, event: "open", ageSec: 1, decisionAt: T0,
    opened: tradeSide("ETH-Arb", { strategy: "one", config: null, hl: undefined }), costs: COSTS,
  }));
  assert.equal(row.pos.st, "one");
  assert.equal(row.pos.h, null, "ноги нет: null это не объект из пяти null с кодами нехватки");
  assert.equal(row.pos.x, undefined, "кодов нехватки по несуществующей ноге не бывает");
  assert.equal(row.pos.g.col, 1995.26, "нога GMX при этом наблюдена полностью");

  const one = note(snap({ position: position({ strategy: "one", config: null, hl: undefined }) }));
  assert.equal(one.p.h, null, "то же в снимке");
  assert.equal(one.xp, undefined);

  // РАЗВИЛКА НЕ ОСЛАБИЛА ПРОВЕРКУ: у двуногой схемы пропавшая нога по-прежнему пропуск наблюдения.
  const two = note(snap({ position: position({ hl: undefined }) }));
  assert.deepEqual(two.xp, ["leg_notional", "leg_collateral", "leg_mark", "leg_liq"]);
});

test("перекладка это ОДНА строка с обеими сторонами и причиной из реестра выхода", () => {
  const row = note(buildFaTradeRecord({
    t: T0, event: "switch", why: "alt_beats_hold", ageSec: 1.5, decisionAt: T0 - 500,
    opened: tradeSide("ETH"), closed: tradeSide("BTC", { realizedUsd: 41.2719 }), costs: COSTS,
  }));
  assert.equal(row.ev, "switch");
  assert.equal(row.why, "alt_beats_hold");
  assert.equal(row.pos.t, "ETH");
  assert.equal(row.prev.t, "BTC");
  assert.equal(row.prev.real, 41.27, "зафиксированный итог закрытой стороны");
  assert.deepEqual(faUnknownCodes(row), []);
});

test("выход в кэш: закрытая сторона есть, открытой нет", () => {
  const row = note(buildFaTradeRecord({
    t: T0, event: "close", why: "gross_negative", ageSec: 1,
    closed: tradeSide("BTC", { realizedUsd: -12.5 }), costs: COSTS,
  }));
  assert.equal(row.pos, null);
  assert.equal(row.prev.real, -12.5);
  assert.equal(row.why, "gross_negative");
});

test("причина сделки вне реестра выхода видна полем xc, а событие вне реестра не пишется вовсе", () => {
  const row = note(buildFaTradeRecord({ t: T0, event: "close", why: "надоело", closed: tradeSide("BTC") }));
  assert.deepEqual(row.xc, ["exit:надоело"]);
  assert.equal(buildFaTradeRecord({ t: T0, event: "переложились", opened: tradeSide("BTC") }), null,
    "род события не из реестра: строка не пишется, потому что читать её было бы нечем");
  assert.equal(buildFaTradeRecord({ event: "open", opened: tradeSide("BTC") }), null);
});

test("нога сделки без залога или ликвидации называет пропуск и в паспорте тоже", () => {
  const row = note(buildFaTradeRecord({
    t: T0, event: "open", opened: tradeSide("BTC", { gmx: leg({ collateralUsd: undefined, liquidationPx: undefined }) }),
  }));
  assert.ok(row.pos.x.includes("leg_collateral"));
  assert.ok(row.pos.x.includes("leg_liq"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Нарезка суток, префиксы и срок хранения
// ─────────────────────────────────────────────────────────────────────────────

test("сутки режутся по UTC тем же ключом, что у записи бота 2 и у вёдер телеметрии", () => {
  assert.equal(faRecordDayKey(Date.parse("2026-08-31T00:00:00Z")), "2026-08-31");
  assert.equal(faRecordDayKey(Date.parse("2026-08-31T23:59:59Z")), "2026-08-31");
  assert.equal(faRecordDayKey(Date.parse("2026-09-01T00:00:00Z")), "2026-09-01");
  assert.equal(faRecordDayKey(NaN), null);
  assert.deepEqual({ ...FA_RECORD_PREFIX }, { snap: "fa-snap", dec: "fa-dec", trade: "fa-trade" });
});

test("срок хранения по умолчанию БЕСКОНЕЧЕН: без конечного числа суток не удаляется ничего", () => {
  const days = ["2026-08-01", "2026-08-25", "2026-08-30", "2026-08-31"];
  assert.deepEqual(faRecordsToPrune(days, null, "2026-08-31"), []);
  assert.deepEqual(faRecordsToPrune(days, Infinity, "2026-08-31"), []);
  assert.deepEqual(faRecordsToPrune(days, 0, "2026-08-31"), []);
});

test("при названном сроке хранения сутки за краем перечисляются, но НЕ удаляются", () => {
  const days = ["2026-08-01", "2026-08-25", "2026-08-30", "2026-08-31"];
  assert.deepEqual(faRecordsToPrune(days, 7, "2026-08-31"), ["2026-08-01"]);
  assert.deepEqual(faRecordsToPrune(days, 2, "2026-08-31"), ["2026-08-01", "2026-08-25"]);
  assert.deepEqual(faRecordsToPrune(days, 1, "2026-08-31"), ["2026-08-01", "2026-08-25", "2026-08-30"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. ОБЪЁМ. Числа шапки сверяются с настоящими строками
// ─────────────────────────────────────────────────────────────────────────────

test("FA_RECORD_SIZE сверяется с ДЛИНОЙ настоящих строк: добавленное поле роняет тест", () => {
  // Осознанно строгая проверка. Она обязана падать при любой правке формы строки, потому что
  // таблица мегабайтов в шапке модуля посчитана ИЗ ЭТИХ ЧИСЕЛ и иначе тихо разойдётся с явью.
  const bare = buildFaSnapRecord({ t: T0, gmxAgeSec: 2.1, hlAgeSec: 1.8, markets: [], position: null });
  const withPos = buildFaSnapRecord({ t: T0, gmxAgeSec: 2.1, hlAgeSec: 1.8, markets: [], position: position() });
  const one = buildFaSnapRecord({ t: T0, gmxAgeSec: 2.1, hlAgeSec: 1.8, markets: [market("BTC")], position: position() });
  const two = buildFaSnapRecord({ t: T0, gmxAgeSec: 2.1, hlAgeSec: 1.8, markets: [market("BTC"), market("ETH")], position: position() });
  assert.equal(bytes(bare), FA_RECORD_SIZE.snapFixed, "строка снимка без рынков и без позиции");
  assert.equal(bytes(withPos) - bytes(bare), FA_RECORD_SIZE.snapPos, "блок открытой позиции");
  assert.equal(bytes(two) - bytes(one), FA_RECORD_SIZE.snapMarket, "один рынок со стаканом на восьми узлах");
  assert.equal(bytes(buildFaGapRecord({ fromMs: T0, toMs: T0 + 60 * MIN, nominalSec: 300, hints: { bootAt: T0 + MIN } })),
    FA_RECORD_SIZE.gap);

  const dec = (funded, refused, exit) => buildFaDecisionRecord({
    t: T0, ageSec: 2.1, capitalUsd: 5000, presetId: "fa-per-market-h720-v1", cfg: { ...FA_SIZING_DEFAULTS },
    universe: universe(
      Array.from({ length: funded }, (_, i) => curve(`T${i}`)),
      Array.from({ length: refused }, (_, i) => ({ token: `R${i}`, config: "B", refusal: "below_fund_ratio" })),
    ),
    exit, hold: funded ? "T0" : null, window: { firstTsHour: 1_697_400_000, lastTsHour: 1_699_992_000, rows: 720 },
    gate: gateOf(), // полный вид строки: ворота снабжения пишутся на каждом решении
    trigger: "cadence", // и повод решения тоже
  });
  assert.equal(bytes(dec(0, 0, null)), FA_RECORD_SIZE.decFixed, "строка решения без рынков и без выхода");
  assert.equal(bytes(dec(0, 0, exitOf())) - bytes(dec(0, 0, null)), FA_RECORD_SIZE.decExit, "блок выхода");
  assert.equal(bytes(dec(2, 0, exitOf())) - bytes(dec(1, 0, exitOf())), FA_RECORD_SIZE.decMarket, "один рынок");
  assert.equal(bytes(dec(0, 2, exitOf())) - bytes(dec(0, 1, exitOf())), FA_RECORD_SIZE.decRefusal, "один отказ");

  assert.equal(bytes(buildFaTradeRecord({
    t: T0, event: "switch", why: "alt_beats_hold", ageSec: 2.1, decisionAt: T0 - 1000,
    opened: tradeSide("ETH"), closed: tradeSide("BTC", { realizedUsd: 41.2719 }), costs: COSTS,
  })), FA_RECORD_SIZE.trade, "паспорт перекладки: самая длинная строка записи");
});

test("объём в сутки: боевая клетка шапки воспроизводится вызовом, а не переписана руками", () => {
  // Вселенная приложения это пять рынков, каданс опроса по умолчанию пять минут.
  const v = faVolumePerDay({ markets: 5, pollSec: 300, decisionsPerDay: 1, tradesPerDay: 0.1, gapsPerDay: 1 });
  assert.equal(Number((v.total / 1e6).toFixed(2)), 0.63, "0.63 МБ в сутки, как в таблице шапки");
  assert.equal(Number((v.total * 365 / 1e9).toFixed(2)), 0.23, "0.23 ГБ в год");
  assert.ok(v.snap / v.total > 0.99, "снимки это 99.5% объёма: экономить можно только на них");
  // Прочие клетки таблицы шапки.
  const cell = (markets, pollSec) => Number((faVolumePerDay({ markets, pollSec, decisionsPerDay: 1, tradesPerDay: 0.1, gapsPerDay: 1 }).total / 1e6).toFixed(2));
  assert.equal(cell(25, 300), 2.88);
  assert.equal(cell(25, 60), 14.37);
  assert.equal(cell(63, 300), 7.14);
  assert.equal(cell(63, 60), 35.65);
});

test("объём линеен по частоте и по числу рынков, и нулевая частота даёт ноль", () => {
  const a = faVolumePerDay({ markets: 10, pollSec: 300, decisionsPerDay: 0, tradesPerDay: 0, gapsPerDay: 0 });
  const b = faVolumePerDay({ markets: 10, pollSec: 150, decisionsPerDay: 0, tradesPerDay: 0, gapsPerDay: 0 });
  assert.ok(Math.abs(b.snap - 2 * a.snap) < 1e-6, "вдвое чаще это вдвое больше");
  assert.equal(faVolumePerDay({ markets: 10, pollSec: 0, decisionsPerDay: 0, tradesPerDay: 0, gapsPerDay: 0 }).snap, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Реестры: достижимость, непересечение и изоляция от бота 2
// ─────────────────────────────────────────────────────────────────────────────

test("каждый код реестров записи ДОСТИЖИМ, и достижимого вне реестров нет", () => {
  const both = (reg, seen, label) => {
    const missing = reg.filter((c) => !seen.has(c));
    assert.deepEqual(missing, [], `${label}: коды реестра, которых не получил ни один тест: ${missing.join(", ")}`);
    const extra = [...seen].filter((c) => !reg.includes(c));
    assert.deepEqual(extra, [], `${label}: коды вне реестра: ${extra.join(", ")}`);
  };
  both(FA_SNAP_MISSING, SEEN_MISS, "пропуски наблюдений рынка");
  both(FA_POS_MISSING, SEEN_POS, "пропуски в блоке позиции");
  both(FA_GAP_CAUSES, SEEN_GAP, "причины перерыва опроса");
  both(FA_TRADE_EVENTS, SEEN_EV, "события сделки");
  both(FA_LIQ_SOURCES, SEEN_LIQ, "источники цены ликвидации");
  both(FA_RECORD_SOURCES, SEEN_SRC, "ярлыки источника строки");
  // Род строки: три из четырёх наблюдались выше, четвёртый ниже.
  SEEN_KIND.add("dec");
  both(FA_RECORD_KINDS, SEEN_KIND, "роды строк");
});

test("словари записи НЕ ПЕРЕСЕКАЮТСЯ со словарями отказов правил: предметы разные", () => {
  // Снимок ничего не отказывает, он НАБЛЮДАЕТ, и «наблюдения не было» это не «рынок не
  // финансируем». Одинаковая строка в двух смыслах сделала бы чтение архива двусмысленным.
  const rules = new Set([...FA_SIZING_REFUSALS, ...FA_SIZING_BINDINGS.filter(Boolean), ...FA_EXIT_REASONS]);
  for (const c of [...FA_SNAP_MISSING, ...FA_POS_MISSING, ...FA_GAP_CAUSES]) {
    assert.ok(!rules.has(c), `код записи «${c}» повторяет код правила: читателю архива их не различить`);
  }
  // И обратная сторона: реестры правил переиспользуются, а не копируются. Своих списков отказов
  // входа и причин выхода здесь нет вовсе.
  const src = readFileSync(join(HERE, "..", "src", "engine", "fa", "record.js"), "utf8");
  assert.match(src, /import \{[^}]*FA_SIZING_REFUSALS[^}]*\} from "\.\/sizing\.js"/s);
  assert.match(src, /import \{[^}]*FA_EXIT_REASONS[^}]*\} from "\.\/exit\.js"/s);
  for (const code of ["below_fund_ratio", "decreasing_at_every_size", "alt_beats_hold", "hold_best"]) {
    assert.ok(!src.includes(`"${code}"`), `код «${code}» задублирован строкой вместо ссылки на реестр`);
  }
});

test("замыкание импортов записи НЕ пересекается с ботом 2", () => {
  // У бота 2 идёт живой прогон, и общий модуль между ботами это способ уронить второго правкой
  // первого. Классификация перерывов здесь СВОЯ именно поэтому.
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*import[^"']*["'](\.[^"']+)["']/gm)) walk(join(dirname(file), m[1]));
  };
  walk(join(HERE, "..", "src", "engine", "fa", "record.js"));
  const btc = [...seen].filter((f) => f.includes("btcopt"));
  assert.deepEqual(btc, [], `запись тянет модули бота 2: ${btc.join(", ")}`);
  assert.ok(seen.size >= 6, "замыкание обязано быть непустым, иначе тест проверяет опечатку в пути");
  // Зависимость строго в одну сторону: правила не имеют права знать о записи, иначе получился бы
  // цикл, и «кто кого зовёт» перестало бы быть определено.
  for (const f of ["sizing.js", "exit.js"]) {
    const src = readFileSync(join(HERE, "..", "src", "engine", "fa", f), "utf8");
    assert.ok(!/from\s+["'][^"']*record\.js["']/.test(src), `${f} не имеет права импортировать record.js`);
  }
});

test("в модуле записи нет длинных тире и нет стрелок в прозе", () => {
  const src = readFileSync(join(HERE, "..", "src", "engine", "fa", "record.js"), "utf8");
  // Глифы записаны escape-последовательностями нарочно: иначе САМ ЭТОТ ФАЙЛ содержал бы то,
  // что запрещает, и проверка не выдержала бы применения к себе.
  assert.equal(src.match(/[\u2014\u2013]/g), null, "длинных тире быть не должно");
  assert.equal(src.match(/\u2192/g), null, "стрелок в прозе быть не должно");
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Сшивка архива в ответы оператору (фаза 6)
//
// ЗАЧЕМ ЭТИ ТЕСТЫ. Карточки истории и журнала читают ИМЕННО ЭТИ функции, и ошибка в них не падает,
// а тихо рисует оператору другую сделку: не тот размер, не тот круг издержек, не тот итог. Такую
// ошибку на экране не отличить от правды, поэтому она ловится здесь.
// ─────────────────────────────────────────────────────────────────────────────

const H = 3600_000;

test("сшивка: вход и выход становятся ОДНОЙ сделкой с обоими размерами", () => {
  const rows = [
    buildFaTradeRecord({ t: T0, event: "open", opened: tradeSide("BTC"), costs: COSTS }),
    buildFaTradeRecord({ t: T0 + 5 * H, event: "close", why: "gross_negative",
      closed: tradeSide("BTC", { realizedUsd: 12.5 }), costs: COSTS }),
  ];
  const [tr] = faTradesFromRecords(rows);
  assert.equal(tr.token, "BTC");
  assert.equal(tr.wantUsd, 2500, "заявленный размер обязан доехать до экрана");
  assert.equal(tr.gotUsd, 1995.26, "и фактический рядом с ним: разница 20.2% и есть замер честности");
  assert.equal(tr.hours, 5);
  assert.equal(tr.netUsd, 12.5);
  assert.equal(tr.live, false);
  assert.equal(tr.why, "gross_negative");
  // Круг издержек снимается со строки ВХОДА: на стороне сделки его нет вовсе.
  // 7.20, а не 7.18531: запись округляет статьи до цента, и читатель обязан складывать ЗАПИСАННОЕ,
  // а не исходные числа. Иначе экран разошёлся бы с архивом на копейку и объяснить это было бы нечем.
  assert.equal(tr.costUsd, 7.2, "круг издержек складывается из статей ЗАПИСИ");
  // Брутто это тождество «нетто плюс круг», а не второй способ счёта.
  assert.ok(Math.abs(tr.grossUsd - (12.5 + tr.costUsd)) < 1e-9);
  assert.ok(Math.abs(tr.netPct - 12.5 / 1995.26) < 1e-9, "процент считается к КАПИТАЛУ, а не к ноционалу");
});

test("сшивка: перекладка закрывает прежнюю и открывает следующую ОДНИМ событием", () => {
  const rows = [
    buildFaTradeRecord({ t: T0, event: "open", opened: tradeSide("BTC"), costs: COSTS }),
    buildFaTradeRecord({ t: T0 + 2 * H, event: "switch", why: "alt_beats_hold",
      opened: tradeSide("ETH"), closed: tradeSide("BTC", { realizedUsd: 4.25 }), costs: COSTS }),
    buildFaTradeRecord({ t: T0 + 9 * H, event: "close", why: "gross_negative",
      closed: tradeSide("ETH", { realizedUsd: -3.5 }), costs: COSTS }),
  ];
  const out = faTradesFromRecords(rows);
  assert.equal(out.length, 2, "две сделки, а не три события и не одна");
  // Свежая сверху: оператор смотрит на последнюю, а не листает до неё.
  assert.equal(out[0].token, "ETH");
  assert.equal(out[0].hours, 7);
  assert.equal(out[0].netUsd, -3.5);
  assert.equal(out[1].token, "BTC");
  assert.equal(out[1].hours, 2);
  assert.equal(out[1].why, "alt_beats_hold");
  assert.deepEqual(out.map((r) => r.n), [2, 1], "нумерация идёт от первой сделки, а не от верха экрана");
});

test("сшивка: открытая сделка идёт строкой без итога, а не пропадает", () => {
  const out = faTradesFromRecords([
    buildFaTradeRecord({ t: T0, event: "open", opened: tradeSide("BTC"), costs: COSTS }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].live, true);
  assert.equal(out[0].netUsd, null, "итога у открытой сделки нет: это прочерк, а не ноль");
  assert.equal(out[0].grossUsd, null);
  assert.equal(out[0].hours, null);
  assert.equal(out[0].closedAt, null);
});

test("сшивка: выход без входа в окне читается ИЗ закрывающей стороны, а не теряется", () => {
  // Архив начат с середины (приложение перезапускалось, сутки вышли за окно чтения): строка обязана
  // выйти полной, потому что паспорт закрываемой стороны несёт её собственный вход.
  const out = faTradesFromRecords([
    buildFaTradeRecord({ t: T0 + H, event: "close", why: "hold_best",
      closed: tradeSide("BTC", { realizedUsd: 1.75 }), costs: COSTS }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].token, "BTC");
  assert.equal(out[0].gotUsd, 1995.26);
  assert.equal(out[0].netUsd, 1.75);
  assert.equal(out[0].openedAt, null, "времени входа в окне нет, и выдумывать его нельзя");
  assert.equal(out[0].hours, null);
  assert.equal(out[0].costUsd, null, "круга входа в окне тоже нет: прочерк, а не чужое число");
});

test("журнал решений: лучший кандидат тем же порядком, что и ранг занятого", () => {
  const uni = universe([curve("BTC", { netUsd: 10 }), curve("ETH", { netUsd: 40 }), curve("SOL", { netUsd: 25 })]);
  const row = buildFaDecisionRecord({ t: T0, capitalUsd: 2500, universe: uni, hold: "SOL" });
  const [d] = faDecisionsFromRecords([row]);
  assert.equal(d.bestToken, "ETH", "лучший это максимум нетто");
  assert.equal(d.heldRank, faHeldRank(row), "ранг берётся у движка, а не считается второй раз");
  assert.equal(d.heldRank, 2, "SOL второй из трёх");
  assert.equal(d.passed, 3);
  assert.equal(d.hold, "SOL");
});

test("журнал решений: доля удержания едет как есть, годовой ставки в записи нет вовсе", () => {
  const uni = universe([curve("BTC", { netUsd: 10, dilutionRetained: 0.088 })]);
  const [d] = faDecisionsFromRecords([buildFaDecisionRecord({ t: T0, capitalUsd: 2500, universe: uni })]);
  assert.equal(d.bestRetained, 0.088,
    "показывается ДОЛЯ УДЕРЖАНИЯ: котируемой годовой ставки поток решений не пишет");
  const keys = Object.keys(d);
  for (const k of keys) assert.ok(!/apr|annual|year/i.test(k), `${k}: годовой оценки в журнале быть не может`);
});

test("журнал решений: свежие сверху, чужие строки не подмешиваются", () => {
  const uni = universe([curve("BTC")]);
  const rows = [
    buildFaDecisionRecord({ t: T0, capitalUsd: 2500, universe: uni }),
    buildFaDecisionRecord({ t: T0 + 2 * H, capitalUsd: 2500, universe: uni }),
    buildFaGapRecord({ fromMs: T0, toMs: T0 + H, nominalSec: 300 }),
  ];
  const out = faDecisionsFromRecords(rows);
  assert.equal(out.length, 2, "строка пропуска в журнал решений не попадает");
  assert.ok(out[0].at > out[1].at, "свежая сверху");
});

test("решение несёт окно назад и повод: без них цену внеочередных решений по записи не снять", () => {
  // Решение владельца 2026-09-02: между кадансами правило зовётся по событию, и у каждого решения
  // записывается повод `tr`; окно оценки `wn` пишется отдельно от горизонта `hz`, потому что
  // читатель не имеет права выводить одно из другого.
  const row = decision({ trigger: "neg_streak" });
  assert.equal(row.wn, 720);
  assert.equal(row.hz, 720);
  assert.equal(row.tr, "neg_streak");
  assert.equal(decision().tr, null, "без повода null, а не выдуманный «каданс»");
  const odd = decision({ trigger: "придумали" });
  assert.equal(odd.tr, "придумали", "сам повод записан: терять наблюдение нельзя");
  assert.deepEqual(faUnknownCodes(odd), ["trig:придумали"], "повод вне реестра виден полем xc");
  const [d] = faDecisionsFromRecords([row]);
  assert.equal(d.trigger, "neg_streak");
  assert.equal(d.windowH, 720);
  const split = decision({ cfg: { ...FA_SIZING_DEFAULTS, windowH: 360 } });
  assert.equal(split.wn, 360);
  assert.deepEqual(split.cfgd, { windowH: 360 }, "отличие окна от умолчания пишется разницей");
});
