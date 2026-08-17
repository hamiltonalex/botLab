// otmscan-sanity.test.js - санитария инструмента схемы продавца: tri-state по трём осям,
// режим off исключает ось из вердикта целиком, fail побеждает unknown, оба являются вето.

import test from "node:test";
import assert from "node:assert/strict";
import { SELL_SANITY_DEFAULTS, evaluateInstrumentSanity, summarizeSanityFailure } from "../src/engine/otmscan/sanity.js";

const NOW = 1_700_000_000_000;
// Здоровая строка: свежий тикер, спред 2/3000 = 0.07% премии, глубина $20k/$25k.
const good = () => ({
  n: "BTC_USDC-1JAN27-100000-C", h: 480, s: "C", m: 3000, d: 0.45,
  b: 2999, a: 3001, iv: 45, vg: 120,
  ts: NOW - 10_000, bidDepthUsd: 20_000, askDepthUsd: 25_000,
});

const byKey = (res, key) => res.rows.find((r) => r.key === key);

test("sanity: здоровая строка проходит все три оси", () => {
  const res = evaluateInstrumentSanity(good(), SELL_SANITY_DEFAULTS, NOW);
  assert.equal(res.verdict, "pass");
  assert.equal(res.rows.length, 3, "все три оси в знаменателе");
  for (const r of res.rows) assert.equal(r.state, "pass", r.key);
  assert.equal(res.instrument, "BTC_USDC-1JAN27-100000-C");
});

test("sanity: протухший тикер валит ось возраста", () => {
  const row = { ...good(), ts: NOW - 120_000 }; // 120 с при пороге 60 с
  const res = evaluateInstrumentSanity(row, SELL_SANITY_DEFAULTS, NOW);
  assert.equal(byKey(res, "age").state, "fail");
  assert.equal(res.verdict, "fail");
});

test("sanity: возраст без метки тикера это unknown, и он тоже вето", () => {
  const row = { ...good(), ts: undefined };
  const res = evaluateInstrumentSanity(row, SELL_SANITY_DEFAULTS, NOW);
  assert.equal(byKey(res, "age").state, "unknown");
  assert.equal(res.verdict, "unknown", "unknown блокирует, но не притворяется fail");
});

test("sanity: широкий спред валит, перевёрнутый bid/ask даёт unknown", () => {
  const wide = { ...good(), b: 2800, a: 3200 }; // 400/3000 = 13.3% при пороге 8%
  assert.equal(byKey(evaluateInstrumentSanity(wide, SELL_SANITY_DEFAULTS, NOW), "spread").state, "fail");
  const crossed = { ...good(), b: 3010, a: 2990 };
  assert.equal(byKey(evaluateInstrumentSanity(crossed, SELL_SANITY_DEFAULTS, NOW), "spread").state, "unknown");
});

test("sanity: глубина ниже порога валит, отсутствие книги даёт unknown", () => {
  const thin = { ...good(), bidDepthUsd: 900, askDepthUsd: 40_000 }; // min $0.9k при пороге $5k
  assert.equal(byKey(evaluateInstrumentSanity(thin, SELL_SANITY_DEFAULTS, NOW), "depth").state, "fail");
  const nobook = { ...good(), bidDepthUsd: undefined, askDepthUsd: undefined };
  assert.equal(byKey(evaluateInstrumentSanity(nobook, SELL_SANITY_DEFAULTS, NOW), "depth").state, "unknown");
});

test("sanity: fail побеждает unknown в сводном вердикте", () => {
  const row = { ...good(), ts: undefined, b: 2800, a: 3200 }; // возраст unknown, спред fail
  const res = evaluateInstrumentSanity(row, SELL_SANITY_DEFAULTS, NOW);
  assert.equal(res.verdict, "fail");
});

test("sanity: режим off исключает ось из rows и из вердикта", () => {
  const cfg = { ...SELL_SANITY_DEFAULTS, depthMode: "off" };
  const thin = { ...good(), bidDepthUsd: 1, askDepthUsd: 1 }; // валила бы глубину
  const res = evaluateInstrumentSanity(thin, cfg, NOW);
  assert.equal(res.rows.length, 2);
  assert.equal(byKey(res, "depth"), undefined);
  assert.equal(res.verdict, "pass");
});

test("sanity: все оси off дают пустые rows и pass на ЛЮБОЙ строке (вырождение прогона записи)", () => {
  const cfg = { ...SELL_SANITY_DEFAULTS, ageMode: "off", spreadMode: "off", depthMode: "off" };
  const junk = { n: "X", m: 0, b: null, a: null }; // строка записи без ts и книг
  const res = evaluateInstrumentSanity(junk, cfg, NOW);
  assert.deepEqual(res.rows, []);
  assert.equal(res.verdict, "pass", "вырожденная санитария физически не может наложить вето");
});

test("summarizeSanityFailure: считает вето по осям и сортирует по частоте", () => {
  const cfg = SELL_SANITY_DEFAULTS;
  const checks = [
    evaluateInstrumentSanity({ ...good(), b: 2800, a: 3200 }, cfg, NOW), // спред fail
    evaluateInstrumentSanity({ ...good(), b: 2700, a: 3300 }, cfg, NOW), // спред fail
    evaluateInstrumentSanity({ ...good(), bidDepthUsd: 1, askDepthUsd: 1 }, cfg, NOW), // глубина fail
  ];
  const s = summarizeSanityFailure(checks);
  assert.match(s, /^спред: /, "самая частая ось первой");
  assert.match(s, /2 из 3/);
  assert.match(s, /глубина: /);
  assert.match(s, /1 из 3/);
});

test("summarizeSanityFailure: без вето честно говорит, что все прошли", () => {
  assert.equal(summarizeSanityFailure([evaluateInstrumentSanity(good(), SELL_SANITY_DEFAULTS, NOW)]), "все проверки прошли");
  assert.equal(summarizeSanityFailure([]), "все проверки прошли");
});
