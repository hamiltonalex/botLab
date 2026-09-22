// btcopt-regime.test.js - IV-режим (Фаза 3b): золотой iv_rank, признак набранного окна
// (ivMinObs / плоское окно), строгие края окна, выбор новейшего конечного значения, отсутствие
// мутации входа. PURE, фикстуры по месту, явные Date.UTC (ни одного Date.now).
//
// ОТДЕЛЬНО СТЕРЕЖЁТСЯ ОТСУТСТВИЕ ВЕРДИКТА. Модуль возвращал признак «вход благоприятен», считанный
// по схеме ПОКУПАТЕЛЯ волатильности, тогда как живой бот её ПРОДАЁТ: зелёный горел наоборот.
// Признак убран (разбор в шапке regime.js), и тест ниже не даёт ему вернуться молча.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRegime } from "../src/engine/btcopt/regime.js";

const near = (a, b, tol, l) => assert.ok(Math.abs(a - b) < tol, `${l}: got ${a} want ${b} (±${tol})`);

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0); // 15JUL26 12:00 UTC
const HOUR = 3_600_000;
const at = (hoursAgo, atmIv, dvol) => ({ ts: NOW - hoursAgo * HOUR, atmIv, ...(dvol !== undefined ? { dvol } : {}) });

// 13 hourly observations inside the 24h window: extremes 20 / 40, the latest = `last` (n 13 ≥ minObs 12).
const series13 = (last) => [at(12, 20), at(11, 40), ...Array.from({ length: 10 }, (_, i) => at(10 - i, 30)), at(0, last)];

test("золотой iv_rank: окно min 20 / max 40 / последняя 25 → 0.25, окно набрано", () => {
  const r = computeRegime(series13(25), { nowMs: NOW });
  assert.equal(r.n, 13);
  assert.equal(r.atm_iv, 25);
  near(r.iv_rank, 0.25, 1e-12, "(25−20)/(40−20)");
  assert.equal(r.enough, true);
  assert.equal(r.dvol, null, "no dvol observation anywhere → null");
  assert.equal(r.window_sec, 86400);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r, "output is JSON-safe");
});

test("высокий ранг это ЧИСЛО, а не суждение: вердикта модуль не выносит", () => {
  const r = computeRegime(series13(34), { nowMs: NOW });
  assert.equal(r.n, 13);
  near(r.iv_rank, 0.7, 1e-12, "(34−20)/(40−20)");
  assert.equal(r.enough, true, "окно набрано - это про данные, а не про выгодность входа");
});

test("вердикта нет НИ В ОДНОМ состоянии, и вернуться молча он не может", () => {
  // Стережётся именно ИМЯ ПОЛЯ: пока его нет, карточка не может снова начать красить вход зелёным
  // по суждению чужой схемы. Ключ проверяется в каждом состоянии, включая пустое.
  const states = [
    computeRegime(series13(25), { nowMs: NOW }),
    computeRegime(series13(34), { nowMs: NOW }),
    computeRegime([at(1, 42)], { nowMs: NOW }),
    computeRegime([], { nowMs: NOW }),
  ];
  for (const r of states) {
    assert.ok(!("favorable" in r), `вердикт вернулся: ${JSON.stringify(r)}`);
    assert.deepEqual(Object.keys(r).sort(), ["atm_iv", "dvol", "enough", "iv_rank", "n", "window_sec"]);
  }
});

test("окно не набрано ниже ivMinObs, хотя ранг уже считается", () => {
  const five = [at(4, 20), at(3, 40), at(2, 30), at(1, 30), at(0, 25)];
  const r = computeRegime(five, { nowMs: NOW });
  assert.equal(r.n, 5);
  near(r.iv_rank, 0.25, 1e-12, "ранг существует уже при n ≥ 2");
  assert.equal(r.enough, false, "5 < ivMinObs 12: карточка печатает «мало данных»");
  // те же пять наблюдений при ivMinObs 5 окно уже набирают
  assert.equal(computeRegime(five, { nowMs: NOW, cfg: { ivMinObs: 5 } }).enough, true);
});

test("n < 2 → iv_rank null (ранжировать не против чего), окно не набрано", () => {
  const r = computeRegime([at(1, 42)], { nowMs: NOW });
  assert.equal(r.n, 1);
  assert.equal(r.atm_iv, 42);
  assert.equal(r.iv_rank, null);
  assert.equal(r.enough, false);
});

test("плоское окно (все значения равны) → ранг 0.5 по политике модуля", () => {
  const flat = Array.from({ length: 12 }, (_, i) => at(11 - i, 30));
  const r = computeRegime(flat, { nowMs: NOW });
  assert.equal(r.n, 12);
  near(r.iv_rank, 0.5, 1e-12, "constant series sits mid-range");
  assert.equal(r.enough, true, "плоское окно это набранное окно: наблюдений хватает");
  // a permissive threshold flips the verdict - the 0.5 policy value itself is unchanged
  near(computeRegime(flat, { nowMs: NOW }).iv_rank, 0.5, 1e-12, "ранг плоского окна ровно посередине");
});

test("window edges: ts ≤ now − window excluded (strict >), ts > now excluded, ts = now included", () => {
  const series = [
    { ts: NOW - 86_400_000, atmIv: 1 }, // exactly ON the left edge → excluded
    { ts: NOW - 100_000_000, atmIv: 2 }, // far past → excluded
    { ts: NOW + 1, atmIv: 100 }, // future → excluded
    at(2, 20),
    at(1, 40),
    { ts: NOW, atmIv: 25 }, // right edge → included
  ];
  const r = computeRegime(series, { nowMs: NOW });
  assert.equal(r.n, 3, "only the 3 in-window entries counted");
  assert.equal(r.atm_iv, 25);
  near(r.iv_rank, 0.25, 1e-12, "min/max unpolluted by the 1 / 2 / 100 outside the window");
});

test("cfg.ivWindowSec shrinks the window (and is echoed as window_sec)", () => {
  const series = [at(2, 10), at(1, 20), at(0.5, 30), at(0, 40)]; // 1h window: at(1) sits ON the edge → out
  const r = computeRegime(series, { nowMs: NOW, cfg: { ivWindowSec: 3600 } });
  assert.equal(r.window_sec, 3600);
  assert.equal(r.n, 2);
  assert.equal(r.atm_iv, 40);
  near(r.iv_rank, 1, 1e-12, "(40−30)/(40−30) - the latest is the window max");
});

test("newest-finite selection: nulls skipped, unsorted input handled, input NOT mutated", () => {
  const series = [
    { ts: NOW, atmIv: null, dvol: null }, // newest entry - both fields null → skipped for both
    { ts: NOW - 2 * HOUR, atmIv: 33, dvol: 44 }, // newest FINITE dvol
    { ts: NOW - 1 * HOUR, atmIv: 35 }, // newest FINITE atmIv (carries no dvol at all)
    { ts: NOW - 3 * HOUR, atmIv: 20, dvol: 40 },
  ]; // deliberately out of ts order
  const before = JSON.parse(JSON.stringify(series));
  const r = computeRegime(series, { nowMs: NOW });
  assert.equal(r.atm_iv, 35, "newest finite atmIv - the null at ts=now is skipped");
  assert.equal(r.dvol, 44, "newest finite dvol - picked independently of the atm_iv entry");
  assert.equal(r.n, 3, "the null-atmIv entry does not count toward n");
  near(r.iv_rank, 1, 1e-12, "(35−20)/(35−20)");
  assert.deepEqual(series, before, "input array untouched (same order, same values)");
});

test("empty / out-of-window-only / non-array input → the all-null shape with n 0", () => {
  const empty = { atm_iv: null, dvol: null, iv_rank: null, enough: false, n: 0, window_sec: 86400 };
  assert.deepEqual(computeRegime([], { nowMs: NOW }), empty);
  assert.deepEqual(computeRegime([{ ts: NOW - 2 * 86_400_000, atmIv: 50 }], { nowMs: NOW }), empty);
  assert.deepEqual(computeRegime(undefined, { nowMs: NOW }), empty);
});

// --- Phase 3b integration: evaluate() forwards snapshot.ivContext → cycle.iv_regime -------------------
import { create, evaluate } from "../src/engine/btcopt/engine.js";

// A minimal FLAT snapshot (no structure, no perp) - evaluate() runs its SKIP path and still computes
// the entry signal: IV regimes matter most while flat.
const flatSnap = (ivContext) => ({
  ts: NOW,
  underlying: 63000,
  index: 63000,
  legs: {},
  perp: null,
  liquidity: null,
  fresh: { ageSec: 0, stale: false, ok: true, gateOk: true, source: "test", testnet: false, notes: [] },
  ...(ivContext ? { ivContext } : {}),
});

// 14 obs 30s apart (n ≥ ivMinObs 12); ramp 20..44 then a NEWEST 22 → min 20 / max 44 → rank
// (22−20)/24 ≈ 0.083. dvol 50 до новейшего 55 → dvol_rank = 1.
const IV_SERIES = [
  ...Array.from({ length: 13 }, (_, i) => ({ ts: NOW - (14 - i) * 30_000, atmIv: 20 + i * 2, dvol: 50 })),
  { ts: NOW - 30_000, atmIv: 22, dvol: 55 },
];

test("evaluate forwards ivContext → cycle.iv_regime (+ dvol_rank) even while FLAT", () => {
  const st = create({ nowMs: NOW });
  const cyc = evaluate(st, flatSnap({ series: IV_SERIES }), NOW);
  const r = cyc.iv_regime;
  assert.ok(r, "iv_regime present");
  assert.equal(r.atm_iv, 22);
  assert.equal(r.dvol, 55);
  near(r.iv_rank, (22 - 20) / (44 - 20), 1e-12, "iv_rank");
  assert.equal(r.enough, true, "14 наблюдений ≥ ivMinObs 12");
  assert.equal(r.n, 14);
  assert.equal(r.window_sec, 86400);
  near(r.dvol_rank, 1, 1e-12, "dvol 55 at the top of {50,55}");
});

test("evaluate without ivContext → cycle.iv_regime is null (fixtures unchanged ⇒ determinism intact)", () => {
  const st = create({ nowMs: NOW });
  assert.equal(evaluate(st, flatSnap(null), NOW).iv_regime, null);
});

test("evaluate + ivContext is deterministic (fresh state, same inputs → deepEqual cycles)", () => {
  const a = evaluate(create({ nowMs: NOW }), flatSnap({ series: IV_SERIES }), NOW);
  const b = evaluate(create({ nowMs: NOW }), flatSnap({ series: IV_SERIES }), NOW);
  assert.deepEqual(a, b);
});

test("IV-режим слушает ЖИВЫЕ настройки (ivMinObs выше числа наблюдений → окно не набрано)", () => {
  // Свойство то же, что проверялось прежде порогом вердикта: настройки профиля доезжают до модуля.
  // Порога вердикта больше нет, поэтому свойство стережётся оставшейся настройкой окна.
  const st = create({ nowMs: NOW, settings: { ivMinObs: 50 } });
  const r = evaluate(st, flatSnap({ series: IV_SERIES }), NOW).iv_regime;
  assert.equal(r.n, 14);
  assert.equal(r.enough, false, "14 < ivMinObs 50");
});
