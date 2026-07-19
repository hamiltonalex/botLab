// otmscan-rv.test.js — S0: реализованная волатильность / импульс / EMA (rv.js), план §5.1.
// Детерминизм: синтетические свечи с известными ответами; незакрытый бар; дыры в окне.

import test from "node:test";
import assert from "node:assert/strict";
import { tvToCandles, closedCandles, realizedVolPct, emaLast, computeRvBundle, HOUR_MS } from "../src/engine/otmscan/rv.js";

const BASE = Date.UTC(2026, 0, 1); // полуночь UTC, часовая сетка
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) < tol, `${label}: got ${a}, want ${b} (+/-${tol})`);
const mkCandles = (closes, t0 = BASE) => closes.map((close, i) => ({ ts: t0 + i * HOUR_MS, open: close, high: close, low: close, close }));

test("tvToCandles: параллельные массивы, drop non-finite, дедуп по ts (последний побеждает), сортировка", () => {
  const tv = {
    ticks: [BASE + HOUR_MS, BASE, BASE, NaN],
    open: [1, 2, 3, 4],
    high: [1, 2, 3, 4],
    low: [1, 2, 3, 4],
    close: [101, 100, 99, 98],
  };
  const c = tvToCandles(tv);
  assert.equal(c.length, 2);
  assert.deepEqual(c.map((x) => x.ts), [BASE, BASE + HOUR_MS]); // отсортировано
  assert.equal(c[0].close, 99); // дубль BASE: перезаписан последним вхождением
});

test("closedCandles: бар в процессе исключается", () => {
  const candles = mkCandles([100, 101, 102]);
  const now = BASE + 2 * HOUR_MS + 1000; // третий бар (ts=BASE+2h) ещё не закрыт
  const closed = closedCandles(candles, now);
  assert.equal(closed.length, 2);
  assert.equal(closed[1].close, 101);
});

test("realizedVolPct: чередующиеся ±1% лог-доходности дают известную annualized RV", () => {
  // 25 баров в окне bars=25 → 24 доходности ровно ±0.01 (лог), среднее 0.
  const closes = [100];
  for (let i = 0; i < 24; i++) closes.push(closes[closes.length - 1] * Math.exp(i % 2 === 0 ? 0.01 : -0.01));
  const candles = mkCandles(closes);
  const now = BASE + 25 * HOUR_MS; // все 25 закрыты, окно ровно 25 слотов
  const r = realizedVolPct(candles, { bars: 25, nowMs: now });
  assert.equal(r.nPairs, 24);
  const sd = 0.01 * Math.sqrt(24 / 23); // выборочное СКО чередующихся ±0.01
  near(r.rvPct, sd * Math.sqrt(365 * 24) * 100, 1e-9, "annualized rv");
});

test("realizedVolPct: константная серия даёт RV 0, дыры >10% дают null", () => {
  const flat = mkCandles(Array(25).fill(100));
  const now = BASE + 25 * HOUR_MS;
  assert.equal(realizedVolPct(flat, { bars: 25, nowMs: now }).rvPct, 0);

  const holed = flat.filter((_, i) => i < 10 || i >= 15); // вырезаны 5 середины → пары 9+9=18 < 0.9·24
  const r = realizedVolPct(holed, { bars: 25, nowMs: now });
  assert.equal(r.rvPct, null);
  assert.equal(r.nPairs, 18);
});

test("emaLast: константа даёт константу; меньше периода — null", () => {
  assert.equal(emaLast(Array(30).fill(7), 20), 7);
  assert.equal(emaLast([1, 2, 3], 20), null);
});

test("computeRvBundle: направление и Δ24h от последнего ЗАКРЫТОГО бара; незакрытый игнорируется", () => {
  const n = 8 * 24; // 8 дней часовых баров
  const closes = Array(n).fill(100);
  closes[n - 1] = 102; // скачок в последнем закрытом баре
  const candles = mkCandles(closes);
  const lastClosedTs = BASE + (n - 1) * HOUR_MS;
  const now = lastClosedTs + HOUR_MS + 1000;
  candles.push({ ts: lastClosedTs + HOUR_MS, open: 999, high: 999, low: 999, close: 999 }); // бар в процессе
  const b = computeRvBundle(candles, now);
  assert.equal(b.lastClose, 102);
  near(b.dP24hPct, 2, 1e-9, "Δ24h");
  assert.equal(b.direction, "call");
  assert.ok(Number.isFinite(b.rv7dPct) && b.rv7dPct > 0, "rv7d конечна и положительна");
  assert.ok(Number.isFinite(b.impulse) && b.impulse > 0, "импульс конечен");
  assert.ok(Number.isFinite(b.ema), "EMA готова");
});

test("computeRvBundle: пустой вход даёт null-поля, не исключение", () => {
  const b = computeRvBundle([], BASE);
  assert.equal(b.rv7dPct, null);
  assert.equal(b.impulse, null);
  assert.equal(b.direction, null);
  assert.equal(b.lastClose, null);
});
