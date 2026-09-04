// otmscan-surface.test.js - строки записи поверхности (src/engine/otmscan/surface.js).
// Доказывает: (1) сшивка summary с метами chain по instrument_name; (2) КАЖДАЯ причина пропуска
// считается явно, молчаливых потерь строк нет; (3) округление сохраняет null (нет котировки - не
// ноль); (4) греки в строке совпадают с прямым вызовом black76 от тех же полей; (5) детерминированная
// сортировка; (6) потолок горизонта; (7) сверка с биржевыми греками берёт только пересечение и не
// выдумывает относительную ошибку при нулевом биржевом греке; (8) сводка считает полосу дельты.
//
// Форма фикстуры - с ЖИВОГО ответа Deribit 2026-08-03 (поля bid_price/ask_price/mark_price/
// mid_price/mark_iv/underlying_price/open_interest/volume_usd), поэтому тест ловит переименование
// полей биржей, а не только регрессии нашей логики.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  surfaceRow,
  buildSurfaceRows,
  buildGreekChecks,
  buildLegGreekChecks,
  summarizeSurface,
  BTC_USDC_PREFIX,
} from "../src/engine/otmscan/surface.js";
import { black76Greeks, yearsToExpiry } from "../src/engine/otmscan/black76.js";

const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);
const H = 3600000;

const meta = (name, expH, strike, type) => ({
  instrument_name: name,
  expiration_timestamp: NOW + expH * H,
  strike,
  option_type: type,
});
const sum = (name, over = {}) => ({
  instrument_name: name,
  bid_price: 540,
  ask_price: 575,
  mark_price: 570.16,
  mid_price: 557.5,
  mark_iv: 30.69,
  underlying_price: 63919.23,
  open_interest: 1.83,
  volume_usd: 1317.34,
  ...over,
});

const CHAIN = [
  meta("BTC_USDC-7AUG26-63500-P", 96, 63500, "put"),
  meta("BTC_USDC-7AUG26-63500-C", 96, 63500, "call"),
  meta("BTC_USDC-7AUG26-66000-C", 96, 66000, "call"),
  meta("BTC_USDC-5AUG26-64000-C", 48, 64000, "call"),
  meta("BTC_USDC-1AUG26-63000-C", -24, 63000, "call"), // экспирация в прошлом
];

test("сшивка по instrument_name: строка несёт страйк, срок и сторону из меты", () => {
  const { rows } = buildSurfaceRows({
    summary: [sum("BTC_USDC-7AUG26-63500-P")],
    chainMetas: CHAIN,
    nowMs: NOW,
  });
  assert.equal(rows.length, 1);
  const x = rows[0];
  assert.equal(x.n, "BTC_USDC-7AUG26-63500-P");
  assert.equal(x.k, 63500);
  assert.equal(x.s, "P");
  assert.equal(x.h, 96, "часы до экспирации");
  assert.equal(x.e, NOW + 96 * H);
  assert.equal(x.iv, 30.69);
  assert.equal(x.f, 63919.23, "форвард СВОЕЙ экспирации, не спот");
});

test("каждая причина пропуска считается: чужой префикс, нет меты, экспирация прошла, нет IV", () => {
  const { rows, skipped } = buildSurfaceRows({
    summary: [
      sum("BTC_USDC-7AUG26-63500-P"), // годная
      sum("ETH_USDC-7AUG26-3000-C"), // чужой актив
      sum("BTC_USDC-9AUG26-70000-C"), // меты нет
      sum("BTC_USDC-1AUG26-63000-C"), // экспирация в прошлом
      sum("BTC_USDC-7AUG26-66000-C", { mark_iv: null }), // без IV греки не считаются
    ],
    chainMetas: CHAIN,
    nowMs: NOW,
  });
  assert.equal(rows.length, 1, "в записи ровно одна годная строка");
  assert.deepEqual(skipped, { notPrefix: 1, noMeta: 1, noIv: 1, expired: 1 });
});

test("нулевая или отрицательная IV - это noIv, а не строка с нулевыми греками", () => {
  const { rows, skipped } = buildSurfaceRows({
    summary: [sum("BTC_USDC-7AUG26-63500-P", { mark_iv: 0 })],
    chainMetas: CHAIN,
    nowMs: NOW,
  });
  assert.equal(rows.length, 0);
  assert.equal(skipped.noIv, 1);
});

test("округление сохраняет null: нет котировки не превращается в ноль", () => {
  const { rows } = buildSurfaceRows({
    summary: [sum("BTC_USDC-7AUG26-66000-C", { bid_price: null, ask_price: undefined, volume_usd: null })],
    chainMetas: CHAIN,
    nowMs: NOW,
  });
  assert.equal(rows[0].b, null, "bid остаётся null");
  assert.equal(rows[0].a, null, "ask остаётся null");
  assert.equal(rows[0].vu, null, "объём остаётся null");
  assert.ok(Number.isFinite(rows[0].m), "mark при этом посчитан");
});

test("греки строки совпадают с прямым вызовом black76 от тех же полей", () => {
  const m = CHAIN[0];
  const s = sum("BTC_USDC-7AUG26-63500-P");
  const x = surfaceRow({ meta: m, row: s, nowMs: NOW });
  const g = black76Greeks({
    forwardUsd: s.underlying_price,
    strikeUsd: m.strike,
    ivPct: s.mark_iv,
    tYears: yearsToExpiry(NOW, m.expiration_timestamp),
    optionType: "put",
  });
  assert.equal(x.d, Number(g.delta.toFixed(4)));
  assert.equal(x.th, Number(g.thetaUsd.toFixed(3)));
  assert.equal(x.vg, Number(g.vegaUsd.toFixed(3)));
  assert.ok(x.d < 0, "дельта пута отрицательна");
  assert.ok(x.th < 0, "тета лонга отрицательна");
});

test("сортировка детерминированная: экспирация, страйк, сторона", () => {
  const { rows } = buildSurfaceRows({
    summary: [
      sum("BTC_USDC-7AUG26-66000-C"),
      sum("BTC_USDC-5AUG26-64000-C"),
      sum("BTC_USDC-7AUG26-63500-P"),
      sum("BTC_USDC-7AUG26-63500-C"),
    ],
    chainMetas: CHAIN,
    nowMs: NOW,
  });
  assert.deepEqual(
    rows.map((x) => x.n),
    [
      "BTC_USDC-5AUG26-64000-C",
      "BTC_USDC-7AUG26-63500-C",
      "BTC_USDC-7AUG26-63500-P",
      "BTC_USDC-7AUG26-66000-C",
    ],
  );
});

test("потолок горизонта отсекает дальние экспирации", () => {
  const { rows } = buildSurfaceRows({
    summary: [sum("BTC_USDC-5AUG26-64000-C"), sum("BTC_USDC-7AUG26-63500-C")],
    chainMetas: CHAIN,
    nowMs: NOW,
    maxHours: 60,
  });
  assert.deepEqual(rows.map((x) => x.n), ["BTC_USDC-5AUG26-64000-C"]);
});

test("пустой или отсутствующий вход не бросает и даёт нулевые счётчики", () => {
  const a = buildSurfaceRows({ summary: [], chainMetas: [], nowMs: NOW });
  assert.deepEqual(a.rows, []);
  assert.deepEqual(a.expiries, []);
  const b = buildSurfaceRows({});
  assert.deepEqual(b.rows, []);
  assert.deepEqual(b.skipped, { notPrefix: 0, noMeta: 0, noIv: 0, expired: 0 });
});

test("список экспираций уникален и отсортирован", () => {
  const { expiries } = buildSurfaceRows({
    summary: [sum("BTC_USDC-7AUG26-63500-C"), sum("BTC_USDC-7AUG26-63500-P"), sum("BTC_USDC-5AUG26-64000-C")],
    chainMetas: CHAIN,
    nowMs: NOW,
  });
  assert.deepEqual(expiries, [NOW + 48 * H, NOW + 96 * H]);
});

test("сверка с биржей: только пересечение, обе формы расхождения, без выдумок при нулевом греке", () => {
  const { rows } = buildSurfaceRows({
    summary: [sum("BTC_USDC-7AUG26-63500-P"), sum("BTC_USDC-7AUG26-66000-C")],
    chainMetas: CHAIN,
    nowMs: NOW,
  });
  const ours = rows.find((x) => x.n === "BTC_USDC-7AUG26-63500-P");
  const checks = buildGreekChecks({
    rows,
    nowMs: NOW,
    tickers: {
      "BTC_USDC-7AUG26-63500-P": { delta: ours.d + 0.001, theta: ours.th, vega: 0 },
      "BTC_USDC-НЕТ-ТАКОГО-C": { delta: 0.5, theta: -1, vega: 1 }, // нет в поверхности
    },
  });
  assert.equal(checks.length, 1, "инструмент вне поверхности в сверку не попадает");
  const c = checks[0];
  assert.equal(c.n, "BTC_USDC-7AUG26-63500-P");
  assert.ok(Math.abs(c.dRel) > 0, "относительная ошибка дельты посчитана");
  assert.equal(c.thRel, 0, "совпавшая тета даёт ровно ноль расхождения");
  assert.equal(c.vgRel, null, "при нулевой биржевой веге относительная ошибка не выдумывается");
  assert.equal(c.ts, NOW);
});

test("сверка не падает на пустом входе", () => {
  assert.deepEqual(buildGreekChecks({}), []);
  assert.deepEqual(buildGreekChecks({ rows: [], tickers: {} }), []);
});

test("сводка: строки, экспирации, наличие котировок и наполнение полосы дельты 0.35-0.55", () => {
  const { rows } = buildSurfaceRows({
    summary: [
      sum("BTC_USDC-7AUG26-63500-P"), // около денег - дельта попадёт в полосу
      sum("BTC_USDC-7AUG26-66000-C", { bid_price: null }), // дальний, без бида
      sum("BTC_USDC-5AUG26-64000-C"),
    ],
    chainMetas: CHAIN,
    nowMs: NOW,
  });
  const s = summarizeSurface(rows);
  assert.equal(s.n, 3);
  assert.equal(s.expiries, 2);
  assert.equal(s.withQuote, 2, "строка без бида не считается котируемой");
  assert.ok(s.inDeltaBand >= 1 && s.deltaCovered, "полоса дельты наполнена");
  assert.ok(s.minH <= s.maxH);
  assert.deepEqual(summarizeSurface([]), {
    n: 0,
    expiries: 0,
    withQuote: 0,
    minH: null,
    maxH: null,
    deltaCovered: false,
  });
});

test("префикс экспортирован и совпадает с боевым", () => {
  assert.equal(BTC_USDC_PREFIX, "BTC_USDC-");
});

// ── сверка формулы на полях ОДНОГО тикера (buildLegGreekChecks)
const leg = (over = {}) => ({
  type: "put",
  strike: 63500,
  expiryMs: NOW + 96 * H,
  underlying: 63919.23,
  markIv: 30.69,
  delta: -0.3905,
  theta: -118.59,
  vega: 20.19,
  ts: NOW,
  ...over,
});

test("leg-сверка: расхождение считается от полей ТОГО ЖЕ тикера, возраст снимка не примешан", () => {
  const g = black76Greeks({
    forwardUsd: 63919.23,
    strikeUsd: 63500,
    ivPct: 30.69,
    tYears: yearsToExpiry(NOW, NOW + 96 * H),
    optionType: "put",
  });
  // Биржевые греки задаём РАВНЫМИ нашим - расхождение обязано быть ровно нулевым.
  const checks = buildLegGreekChecks({
    legs: { "BTC_USDC-7AUG26-63500-P": leg({ delta: g.delta, theta: g.thetaUsd, vega: g.vegaUsd }) },
    nowMs: NOW,
  });
  assert.equal(checks.length, 1);
  const c = checks[0];
  assert.equal(c.kind, "leg", "тип сверки помечен: leg и surface мерят разное");
  assert.equal(c.dRel, 0);
  assert.equal(c.thRel, 0);
  assert.equal(c.vgRel, 0);
  assert.equal(c.h, 96);
});

test("leg-сверка: время берётся из ts НОГИ, а не из момента записи", () => {
  // Нога снята на час раньше момента записи: до экспирации 96ч по её метке, 95ч по nowMs.
  const checks = buildLegGreekChecks({ legs: { X: leg({ ts: NOW }) }, nowMs: NOW + H });
  assert.equal(checks[0].h, 96, "иначе греки сверялись бы с чужим сроком");
});

test("leg-сверка: невычислимая нога не даёт строки «расхождение ноль»", () => {
  const checks = buildLegGreekChecks({
    legs: {
      A: leg({ markIv: null }), // без IV
      B: leg({ underlying: 0 }), // без форварда
      C: leg({ expiryMs: NOW - H }), // экспирация прошла
      D: leg({ type: "future" }), // не опцион
    },
    nowMs: NOW,
  });
  assert.deepEqual(checks, [], "молчание вместо выдуманного нуля");
  assert.deepEqual(buildLegGreekChecks({}), []);
});

test("leg-сверка: отсутствие биржевого грека даёт null расхождения, но строку не убивает", () => {
  const checks = buildLegGreekChecks({ legs: { X: leg({ vega: null }) }, nowMs: NOW });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].vgRel, null, "расхождение по веге не выдумано");
  assert.equal(checks[0].vgEx, null);
  assert.ok(Number.isFinite(checks[0].vgOur), "наша вега при этом посчитана");
  assert.ok(Number.isFinite(checks[0].dRel), "дельта сверена как обычно");
});

test("сводка: срез секунды расчёта (марки и IV есть, bid/ask нет ни у кого) даёт withQuote 0", () => {
  // Замер mbp15 2026-09-04 08:00:25 UTC: биржа опустошает книги всех серий на десятки секунд после
  // экспирации, марки и IV при этом живые. Именно по withQuote ensureBtcOptSellSurface решает, что
  // такой срез нельзя кэшировать на 2 минуты: иначе секунда пустых книг стоит цепочке три минуты.
  const metas = [meta("BTC_USDC-25SEP26-82000-C", 504, 82000, "call"), meta("BTC_USDC-25SEP26-80000-P", 504, 80000, "put")];
  const empty = buildSurfaceRows({
    summary: metas.map((m) => sum(m.instrument_name, { bid_price: null, ask_price: null })),
    chainMetas: metas,
    nowMs: NOW,
  });
  assert.equal(empty.rows.length, 2, "строки без котировок остаются строками: марк и греки на месте");
  assert.equal(summarizeSurface(empty.rows).withQuote, 0);
  const quoted = buildSurfaceRows({ summary: metas.map((m) => sum(m.instrument_name)), chainMetas: metas, nowMs: NOW });
  assert.equal(summarizeSurface(quoted.rows).withQuote, 2);
});
