// fa-events.test.js - СОБЫТИЯ ВНЕОЧЕРЕДНОГО РЕШЕНИЯ (fa/events.js).
//
// РЕШЕНИЕ ВЛАДЕЛЬЦА 2026-09-02: каданс 24 ч остаётся, а между кадансами правило зовётся по событию:
// ставка нашей ноги против нас несколько часов подряд, поток рынка упал вдвое, запас до ликвидации
// сжался. Событие двигает только МОМЕНТ решения. Здесь проверяется сам модуль; что событие
// действительно зовёт правило и как полоса гистерезиса его держит, стережёт fa-auto.test.js.
//
// ЧТО ЗДЕСЬ ГЛАВНОЕ. События меряются ОТНОСИТЕЛЬНО СНИМКА ПРОШЛОГО РЕШЕНИЯ. Абсолютное условие горело
// бы тик за тиком, пока держится, и правило звалось бы каждые пять минут, то есть каданс 5 минут под
// другим именем: ровно та частота, чья цена в кругах измерена и отвергнута. И второе: час без ставок
// или без базы это «неизвестно», он обрывает полосу, а не продлевает её.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FA_DECISION_EVENTS, FA_DECISION_TRIGGERS, FA_EVENT_DEFAULTS,
  decisionContext, detectDecisionEvents, hourlyNetUsd, marketPotUsdPerSec, negativeStreakHours,
} from "../src/engine/fa/events.js";
import { hour } from "./fa-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const POS = { token: "ETH", config: "A", strategy: "two", sizeUsd: 2500 };
const LEG = { strategy: "two", config: "A", sizeUsd: 2500 };
// Конфигурация A держит короткую ногу GMX: час, где получает short, для нас час получения.
const recv = (h, over = {}) => hour(h, { pot: 1e-4, bShort: 1e5, bLong: 1e6, recv: "short", ...over });
const pay = (h, over = {}) => hour(h, { pot: 1e-4, bShort: 1e5, bLong: 1e6, recv: "long", ...over });
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) < tol, `${label}: ${a} против ${b}`);

test("реестры: три события, повод это каданс или событие, пороги названы числом", () => {
  assert.deepEqual([...FA_DECISION_EVENTS], ["neg_streak", "pot_drop", "room_drop"]);
  assert.deepEqual([...FA_DECISION_TRIGGERS], ["cadence", ...FA_DECISION_EVENTS]);
  assert.equal(FA_EVENT_DEFAULTS.eventNegHours, 6);
  assert.equal(FA_EVENT_DEFAULTS.eventPotDropFrac, 0.5);
  assert.equal(FA_EVENT_DEFAULTS.eventRoomDropFrac, 0.1);
});

test("почасовое нетто считается тем же разбором ног и разбавлением, что у леджера; неизвестный час это null", () => {
  const got = hourlyNetUsd(recv(0), LEG);
  // f_short = 1e-9 в секунду, множитель разбавления 1e5/(1e5 + 2500), борроу и Hyperliquid по нулям.
  near(got, 1e-9 * 3600 * 2500 * (1e5 / 102500), 1e-12, "час получения");
  assert.ok(hourlyNetUsd(pay(0), LEG) < 0, "час, где платим мы, отрицателен");
  assert.ok(hourlyNetUsd(recv(0, { bs: 5e-9 }), LEG) < 0, "заимствование выше фандинга: теряем");
  // Нога Hyperliquid входит со знаком стороны: длинная нога A платит ставку HL.
  assert.ok(hourlyNetUsd(recv(0, { hl: 1e-5 }), LEG) < 0, "плата HL перекрывает фандинг GMX");
  assert.ok(hourlyNetUsd(recv(0, { hl: 1e-5 }), { strategy: "one", config: null, sizeUsd: 2500 }) > 0, "у одноногой схемы ноги HL нет");
  assert.equal(hourlyNetUsd(recv(0, { bases: false }), LEG), null, "час без базы это неизвестно, а не убыток");
  assert.equal(hourlyNetUsd({ ...recv(0), f_short: NaN }, LEG), null, "час без ставки это неизвестно");
  assert.equal(hourlyNetUsd(recv(0), { ...LEG, sizeUsd: 0 }), null);
  assert.equal(hourlyNetUsd(null, LEG), null);
});

test("живой час с невязкой тождества выше 1e-6 остаётся известным: допуск живой базы доходит до событий", () => {
  const r = recv(0);
  const drift = { ...r, fbase_long: r.fbase_long * 1.002 }; // невязка 0.2%: база снята позже ставок строки
  assert.equal(hourlyNetUsd(drift, LEG), null, "без метки строгий порог: час неизвестен");
  const live = hourlyNetUsd({ ...drift, fbase_src: "live" }, LEG);
  assert.ok(Number.isFinite(live) && Math.abs(live - hourlyNetUsd(r, LEG)) < 1e-12, "живой час считается как обычный: база нашей стороны та же");
});

test("полоса отрицательных часов считается с конца и обрывается неизвестным часом", () => {
  const rows = [...Array.from({ length: 5 }, (_, h) => recv(h)), ...Array.from({ length: 3 }, (_, h) => pay(5 + h))];
  assert.equal(negativeStreakHours(rows, LEG), 3);
  assert.equal(negativeStreakHours([recv(0), recv(1)], LEG), 0);
  // Час, где платим мы, известен и без базы: разбавление к уплате не применяется (правило 3
  // `dilution.js`), поэтому дыра в базе обрывает полосу только там, где мы получали бы.
  assert.equal(negativeStreakHours([pay(0), pay(1), pay(2, { bases: false })], LEG), 3, "уплата без базы это известный убыток");
  assert.equal(negativeStreakHours([pay(0), pay(1), recv(2, { bases: false })], LEG), 0, "дыра на конце: полосы нет");
  assert.equal(negativeStreakHours([pay(0), recv(1, { bases: false }), pay(2)], LEG), 1, "дыра внутри обрывает счёт");
  assert.equal(negativeStreakHours([], LEG), 0);
  assert.equal(negativeStreakHours(null, LEG), 0);
});

test("поток рынка берётся из живого снимка по тождеству сторон, несошедшееся тождество даёт null", () => {
  const r = recv(0);
  const market = { rates: { f_long: r.f_long, f_short: r.f_short }, live: { bOwnUsd: 1e5, bOtherUsd: 1e6 } };
  near(marketPotUsdPerSec(market, LEG), 1e-4, 1e-15, "поток $/с");
  assert.equal(marketPotUsdPerSec({ ...market, live: { bOwnUsd: 1e5, bOtherUsd: 3e6 } }, LEG), null, "чужая база: потока нет");
  assert.equal(marketPotUsdPerSec({ live: market.live }, LEG), null, "без ставок потока нет");
  assert.equal(marketPotUsdPerSec(null, LEG), null);
  // Мёртвый рынок: поток нулевой, и это НАБЛЮДЕНИЕ, а не отсутствие.
  assert.equal(marketPotUsdPerSec({ rates: { f_long: 0, f_short: 0 }, live: market.live }, LEG), 0);
});

test("снимок решения: рынок, полоса, поток и запас; без рынка снимка нет", () => {
  const rows = [recv(0), pay(1), pay(2)];
  const r = recv(0);
  const market = { rates: { f_long: r.f_long, f_short: r.f_short }, live: { bOwnUsd: 1e5, bOtherUsd: 1e6 } };
  const ctx = decisionContext({ token: "ETH", strategy: "two", config: "A", sizeUsd: 2500, rows, market, roomFrac: 0.98 });
  assert.equal(ctx.token, "ETH");
  assert.equal(ctx.negHours, 2);
  near(ctx.potUsdPerSec, 1e-4, 1e-15, "поток в снимке");
  assert.equal(ctx.roomFrac, 0.98);
  assert.equal(decisionContext({ token: null }), null, "кэш и пустой слот: снимка нет");
  const bare = decisionContext({ token: "ETH", sizeUsd: 2500 });
  assert.equal(bare.negHours, null);
  assert.equal(bare.potUsdPerSec, null);
  assert.equal(bare.roomFrac, null, "NaN не притворяется числом");
});

test("события меряются от снимка: срабатывают на пороге, не горят повторно, без сделки и на чужом рынке молчат", () => {
  const rowsWith = (tail) => [...Array.from({ length: 10 }, (_, h) => recv(h)), ...Array.from({ length: tail }, (_, h) => pay(10 + h))];
  const r = recv(0);
  const market = { rates: { f_long: r.f_long, f_short: r.f_short }, live: { bOwnUsd: 1e5, bOtherUsd: 1e6 } };
  const ctx = { token: "ETH", negHours: 0, potUsdPerSec: 1e-4, roomFrac: 0.98 };
  const quiet = { roomFrac: 0.98 };
  assert.deepEqual(detectDecisionEvents({ position: POS, rows: rowsWith(0), market, margin: quiet, ctx }), [], "ничего не изменилось: событий нет");

  // neg_streak: шесть часов подряд, а на прошлом решении полосы не было.
  const neg = detectDecisionEvents({ position: POS, rows: rowsWith(6), market, margin: quiet, ctx });
  assert.deepEqual(neg, [{ code: "neg_streak", hours: 6, need: 6 }]);
  assert.deepEqual(detectDecisionEvents({ position: POS, rows: rowsWith(5), market, margin: quiet, ctx }), [], "пять часов ниже порога");
  assert.deepEqual(detectDecisionEvents({ position: POS, rows: rowsWith(9), market, margin: quiet, ctx: { ...ctx, negHours: 6 } }), [],
    "полоса уже была в снимке: событие не горит повторно");
  assert.equal(detectDecisionEvents({ position: POS, rows: rowsWith(2), market, margin: quiet, ctx, params: { eventNegHours: 2 } })[0].code, "neg_streak",
    "порог берётся из параметров взвода");

  // pot_drop: поток упал вдвое и больше против снимка.
  const half = { ...market, rates: { f_long: r.f_long / 2.5, f_short: r.f_short / 2.5 } };
  const drop = detectDecisionEvents({ position: POS, rows: rowsWith(0), market: half, margin: quiet, ctx });
  assert.equal(drop.length, 1);
  assert.equal(drop[0].code, "pot_drop");
  near(drop[0].pot, 4e-5, 1e-15, "поток сейчас");
  assert.equal(drop[0].was, 1e-4);
  const mild = { ...market, rates: { f_long: r.f_long * 0.6, f_short: r.f_short * 0.6 } };
  assert.deepEqual(detectDecisionEvents({ position: POS, rows: rowsWith(0), market: mild, margin: quiet, ctx }), [], "минус 40%: порог не взят");
  const dead = { ...market, rates: { f_long: 0, f_short: 0 } };
  assert.equal(detectDecisionEvents({ position: POS, rows: rowsWith(0), market: dead, margin: quiet, ctx })[0].code, "pot_drop", "мёртвый рынок это обвал потока");
  assert.deepEqual(detectDecisionEvents({ position: POS, rows: rowsWith(0), market: half, margin: quiet, ctx: { ...ctx, potUsdPerSec: null } }), [],
    "снимок без потока: сравнивать не с чем");

  // room_drop: запас сжался на десять пунктов и больше.
  const tight = detectDecisionEvents({ position: POS, rows: rowsWith(0), market, margin: { roomFrac: 0.87 }, ctx });
  assert.deepEqual(tight, [{ code: "room_drop", roomFrac: 0.87, was: 0.98, frac: 0.1 }]);
  assert.deepEqual(detectDecisionEvents({ position: POS, rows: rowsWith(0), market, margin: { roomFrac: 0.89 }, ctx }), [], "девять пунктов ниже порога");
  assert.deepEqual(detectDecisionEvents({ position: POS, rows: rowsWith(0), market, margin: null, ctx }), [], "запас неизвестен: события нет");

  // Все три сразу, в порядке реестра.
  const all = detectDecisionEvents({ position: POS, rows: rowsWith(6), market: half, margin: { roomFrac: 0.5 }, ctx });
  assert.deepEqual(all.map((e) => e.code), ["neg_streak", "pot_drop", "room_drop"]);

  // Без сделки, без снимка и на чужом рынке событий нет.
  assert.deepEqual(detectDecisionEvents({ position: null, rows: rowsWith(6), market: half, margin: { roomFrac: 0.5 }, ctx }), []);
  assert.deepEqual(detectDecisionEvents({ position: POS, rows: rowsWith(6), market: half, margin: { roomFrac: 0.5 }, ctx: null }), []);
  assert.deepEqual(detectDecisionEvents({ position: POS, rows: rowsWith(6), market: half, margin: { roomFrac: 0.5 }, ctx: { ...ctx, token: "BTC" } }), []);
});

test("замыкание импортов событий НЕ пересекается с ботом 2", () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*import[^"']*["'](\.[^"']+)["']/gm)) walk(join(dirname(file), m[1]));
  };
  walk(join(HERE, "..", "src", "engine", "fa", "events.js"));
  assert.deepEqual([...seen].filter((f) => f.includes("btcopt")), [], "события тянут модули бота 2");
  assert.ok(seen.size >= 4, "замыкание обязано быть непустым");
  const src = readFileSync(join(HERE, "..", "src", "engine", "fa", "events.js"), "utf8");
  assert.ok(!/from\s+["'][^"']*auto\.js["']/.test(src), "события не имеют права знать об автомате");
});
