// otmscan-stats.test.js — S3b суточная статистика обкатки (src/main/scn-stats.js).
// Доказывает: (1) бины/клампы линейных и edges-спек; (2) квантили из sparse-гистограммы;
// (3) фолд scanCycle: счётчики (тики/Д8/блэкаут/деградация/фазы), значения условий по unit,
// экономика лучшего (rtc/minCap/capOverEq); (4) редьюсер не мутирует вход (deepFreeze);
// (5) ключи сутки UTC × presetId, кольцо telemetryDays; (6) JSON-roundtrip чистый;
// (7) рестарт-счётчик bumpScanStart; (8) смена unit под тем же ключом отбрасывается.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCN_STATS_BINS,
  binCount,
  binIndexOf,
  binBounds,
  histQuantile,
  foldScanStats,
  bumpScanStart,
} from "../src/main/scn-stats.js";

const NOW = Date.UTC(2026, 6, 20, 12, 0, 0); // 2026-07-20 12:00 UTC
const DAY = "2026-07-20";

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};

// Синтетический scanCycle — только поля, которые читает фолд (моки легальны: это тест).
const mkCycle = (over = {}) => ({
  preset: { id: "dmitri-v1" },
  score: { verdict: "none" },
  lifecycle: { phase: "idle", blackout: { active: false } },
  candidates: [{}, {}],
  conditions: [
    { key: "rv7d_gt_iv", unit: "pts", value: 3.2, state: "pass" },
    { key: "spread_cap", unit: "pctPrem", value: 12.5, state: "fail" },
    { key: "depth_min", unit: "usd", value: 700, state: "fail" },
    { key: "book_imbalance", unit: "ratio", value: null, state: "off" }, // null не фолдится
  ],
  economics: { roundTripCostPct: 18.4, minCapitalUsd: 130 },
  ...over,
});
const EXTRA = { degraded: false, equityUsd: 100, repriceSec: 30 };

test("binIndexOf: линейные спеки с клампами в крайние бины", () => {
  const spec = SCN_STATS_BINS.pctPrem; // lo 0, hi 80, step 1
  assert.equal(binIndexOf(spec, 0), 0);
  assert.equal(binIndexOf(spec, 12.5), 12);
  assert.equal(binIndexOf(spec, 79.9), 79);
  assert.equal(binIndexOf(spec, 500), binCount(spec) - 1); // кламп сверху
  assert.equal(binIndexOf(spec, -3), 0); // кламп снизу
  assert.equal(binIndexOf(spec, NaN), null);
  const pts = SCN_STATS_BINS.pts; // lo -40
  assert.equal(binIndexOf(pts, -40), 0);
  assert.equal(binIndexOf(pts, 0), 40);
});

test("binIndexOf/binBounds: edges-спеки (глубина, minCapital)", () => {
  const spec = SCN_STATS_BINS.minCapUsd;
  assert.equal(binIndexOf(spec, 10), 0); // ниже первой грани — первый бин
  assert.equal(binIndexOf(spec, 99.99), 3); // [75, 100)
  assert.equal(binIndexOf(spec, 100), 4); // грань 100 = дефолт-депозит открывает свой бин
  assert.equal(binIndexOf(spec, 1e9), spec.edges.length - 1); // последний открыт вверх
  assert.deepEqual(binBounds(spec, 3), { lo: 75, hi: 100 });
  assert.equal(binBounds(spec, spec.edges.length - 1).hi, null);
});

test("histQuantile: медиана известного распределения с точностью до бина", () => {
  let stats = { days: {} };
  for (let i = 0; i < 79; i++) {
    stats = foldScanStats(stats, mkCycle({ economics: { roundTripCostPct: i + 0.5, minCapitalUsd: null } }), EXTRA, NOW);
  }
  const h = stats.days[DAY]["dmitri-v1"].rtc;
  assert.equal(h.n, 79);
  assert.equal(h.min, 0.5);
  assert.equal(h.max, 78.5);
  const p50 = histQuantile(h, SCN_STATS_BINS.pctPrem, 0.5);
  assert.ok(Math.abs(p50 - 39.5) <= 1, `p50=${p50}`);
  const p90 = histQuantile(h, SCN_STATS_BINS.pctPrem, 0.9);
  assert.ok(Math.abs(p90 - 70.7) <= 1.5, `p90=${p90}`);
  assert.equal(histQuantile(h, SCN_STATS_BINS.pctPrem, 0), 0.5); // клампится в фактический min
});

test("foldScanStats: счётчики тика, значения условий, экономика, ключ сутки×пресет", () => {
  const s1 = foldScanStats({ days: {} }, mkCycle(), EXTRA, NOW);
  const b = s1.days[DAY]["dmitri-v1"];
  assert.equal(b.ticks, 1);
  assert.equal(b.noCand, 0);
  assert.equal(b.candCounts["2"], 1);
  assert.equal(b.phases.idle, 1);
  assert.equal(b.firstTickTs, NOW);
  assert.equal(b.lastTickTs, NOW);
  assert.equal(b.equityUsdLast, 100);
  assert.equal(b.repriceSecLast, 30);
  // Значения: только конечные; off/null не входят.
  assert.equal(b.values.rv7d_gt_iv.n, 1);
  assert.equal(b.values.rv7d_gt_iv.unit, "pts");
  assert.equal(b.values.spread_cap.n, 1);
  assert.equal(b.values.depth_min.n, 1);
  assert.equal(b.values.book_imbalance, undefined);
  // Экономика лучшего: rtc + minCap + депозита не хватает (130 > 100).
  assert.equal(b.rtc.n, 1);
  assert.equal(b.minCap.n, 1);
  assert.equal(b.capOverEq, 1);

  // Второй тик: аккумуляция + инцидент-счётчики + Д8 + вердикт.
  const s2 = foldScanStats(
    s1,
    mkCycle({
      score: { verdict: "signal" },
      lifecycle: { phase: "forming", blackout: { active: true } },
      candidates: [],
      economics: { roundTripCostPct: 21.0, minCapitalUsd: 80 },
    }),
    { ...EXTRA, degraded: true },
    NOW + 30000,
  );
  const b2 = s2.days[DAY]["dmitri-v1"];
  assert.equal(b2.ticks, 2);
  assert.equal(b2.noCand, 1);
  assert.equal(b2.candCounts["0"], 1);
  assert.equal(b2.blackoutTicks, 1);
  assert.equal(b2.degradedTicks, 1);
  assert.equal(b2.verdictSignalTicks, 1);
  assert.equal(b2.phases.forming, 1);
  assert.equal(b2.lastTickTs, NOW + 30000);
  assert.equal(b2.rtc.n, 2);
  assert.equal(b2.capOverEq, 1); // 80 <= 100 не инкрементит
});

test("foldScanStats: вход не мутируется (deepFreeze) и JSON-roundtrip чистый", () => {
  const s1 = foldScanStats({ days: {} }, mkCycle(), EXTRA, NOW);
  deepFreeze(s1);
  const s2 = foldScanStats(s1, mkCycle(), EXTRA, NOW + 30000); // бросит TypeError при мутации замороженного
  assert.equal(s1.days[DAY]["dmitri-v1"].ticks, 1);
  assert.equal(s2.days[DAY]["dmitri-v1"].ticks, 2);
  const rt = JSON.parse(JSON.stringify(s2));
  const s3 = foldScanStats(rt, mkCycle(), EXTRA, NOW + 60000);
  assert.equal(s3.days[DAY]["dmitri-v1"].ticks, 3);
  assert.equal(s3.days[DAY]["dmitri-v1"].values.rv7d_gt_iv.n, 3);
});

test("foldScanStats: пресеты в отдельных вёдрах; сутки UTC режут по ключу; кольцо telemetryDays", () => {
  let stats = foldScanStats({ days: {} }, mkCycle(), EXTRA, NOW);
  stats = foldScanStats(stats, mkCycle({ preset: { id: "dmitri-v2" } }), EXTRA, NOW);
  assert.deepEqual(Object.keys(stats.days[DAY]).sort(), ["dmitri-v1", "dmitri-v2"]);
  assert.equal(stats.days[DAY]["dmitri-v1"].ticks, 1);
  assert.equal(stats.days[DAY]["dmitri-v2"].ticks, 1);

  stats = foldScanStats(stats, mkCycle(), EXTRA, NOW + 86400000); // следующие сутки
  assert.deepEqual(Object.keys(stats.days).sort(), [DAY, "2026-07-21"]);

  // Кольцо: правило telemetryDays=1 выбрасывает старые сутки на следующем фолде.
  const pruned = foldScanStats(stats, mkCycle(), EXTRA, NOW + 3 * 86400000, { telemetryDays: 1 });
  assert.deepEqual(Object.keys(pruned.days), ["2026-07-23"]);
});

test("bumpScanStart: рестарт-счётчик создаёт ведро и не мутирует вход", () => {
  const s0 = { days: {} };
  deepFreeze(s0);
  const s1 = bumpScanStart(s0, "dmitri-v1", NOW);
  assert.equal(s1.days[DAY]["dmitri-v1"].starts, 1);
  assert.equal(s1.days[DAY]["dmitri-v1"].ticks, 0);
  const s2 = bumpScanStart(s1, "dmitri-v1", NOW + 1000);
  assert.equal(s2.days[DAY]["dmitri-v1"].starts, 2);
});

test("смена unit под тем же ключом внутри суток отбрасывается (честная гистограмма одной величины)", () => {
  const c1 = mkCycle({ conditions: [{ key: "iv_discount", unit: "pts", value: 6, state: "pass" }] });
  const c2 = mkCycle({ conditions: [{ key: "iv_discount", unit: "ratio", value: 0.8, state: "pass" }] });
  let stats = foldScanStats({ days: {} }, c1, EXTRA, NOW);
  stats = foldScanStats(stats, c2, EXTRA, NOW + 30000);
  const h = stats.days[DAY]["dmitri-v1"].values.iv_discount;
  assert.equal(h.unit, "pts");
  assert.equal(h.n, 1); // ratio-значение не примешано
});
