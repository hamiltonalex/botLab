// btcopt-metrics.test.js — golden run-metrics (Phase 2b): Sharpe / hit-rate / max drawdown / average
// hedge size / peak Δ-excursion from crafted cycle-return series. PURE, inline fixtures (no fixture files).
// "Cycle" = one reprice tick; cycle return = Δ net_total between consecutive ticks.
import test from "node:test";
import assert from "node:assert/strict";
import { initMetrics, foldCycle, summarize } from "../src/engine/btcopt/metrics.js";

const near = (a, b, tol, l) => assert.ok(Math.abs(a - b) < tol, `${l}: got ${a} want ${b}`);

// Fold a list of cycle records into a fresh accumulator, then summarize.
function run(recs) {
  const acc = initMetrics();
  for (const r of recs) foldCycle(acc, r);
  return { acc, m: summarize(acc) };
}

test("summarize: golden net series [0,.10,.05,.20,.15] → Sharpe / hit-rate / max drawdown", () => {
  // returns [+.10, −.05, +.15, −.05]; n=4, mean .0375, var .00796875 → σ .0892678 → sharpe ≈ .42009
  const { m } = run([0, 0.1, 0.05, 0.2, 0.15].map((net) => ({ net, decision: "SKIP" })));
  assert.equal(m.cycles, 4);
  near(m.avgCycleReturn, 0.0375, 1e-12, "mean cycle return");
  near(m.sharpe, 0.42009, 1e-4, "sharpe = mean/σ (population)");
  near(m.hitRate, 0.5, 1e-12, "hit rate 2/4");
  near(m.maxDrawdown, 0.05, 1e-12, "max drawdown 0.05 (peak .20 → trough .15)");
});

test("foldCycle: hedge count / average size / peak Δ-excursion before a hedge", () => {
  const { m } = run([
    { net: 0, totalDelta: 0.005, decision: "SKIP" },
    { net: 0.01, totalDelta: 0.012, decision: "SKIP" },
    { net: 0.02, totalDelta: 0.021, decision: "HEDGE", hedgeSizeBtc: 0.02 }, // excursion peaked at 0.021
    { net: 0.015, totalDelta: 0.008, decision: "SKIP" }, // window reset after the hedge
    { net: 0.03, totalDelta: 0.015, decision: "HEDGE", hedgeSizeBtc: 0.04 },
  ]);
  assert.equal(m.hedgeCount, 2);
  near(m.avgHedgeSizeBtc, 0.03, 1e-12, "avg hedge size (0.02+0.04)/2");
  near(m.peakDeltaExcursion, 0.021, 1e-12, "largest |Δ| reached before a hedge fired");
});

test("summarize: empty / single-cycle → zeros, no NaN", () => {
  assert.deepEqual(summarize(initMetrics()), {
    cycles: 0, hitRate: 0, sharpe: 0, avgCycleReturn: 0, maxDrawdown: 0,
    hedgeCount: 0, avgHedgeSizeBtc: 0, peakDeltaExcursion: 0, cumFees: 0, cumFunding: 0,
  });
  const { m } = run([{ net: 5, decision: "SKIP" }]); // one tick → no return yet
  assert.equal(m.cycles, 0);
  assert.equal(m.sharpe, 0);
});

test("accumulators survive JSON round-trip (peakNet null, never −Infinity)", () => {
  const acc = initMetrics();
  foldCycle(acc, { net: -3, decision: "SKIP" }); // negative first net — peak must track it, not clamp to 0
  const revived = JSON.parse(JSON.stringify(acc)); // simulate saveBotState → load
  foldCycle(revived, { net: -1, decision: "SKIP" });
  near(summarize(revived).maxDrawdown, 0, 1e-12, "−3 → −1 is a gain, drawdown stays 0");
  foldCycle(revived, { net: -5, decision: "SKIP" });
  near(summarize(revived).maxDrawdown, 4, 1e-12, "−1 → −5 = drawdown 4 (survives reload)");
});

test("cumFees / cumFunding mirror the latest cycle's cumulative values", () => {
  const { m } = run([
    { net: 0, decision: "SKIP", feesCum: 0.1, fundingCum: -0.02 },
    { net: 0.05, decision: "SKIP", feesCum: 0.3, fundingCum: 0.04 },
  ]);
  near(m.cumFees, 0.3, 1e-12, "cumFees = last tick");
  near(m.cumFunding, 0.04, 1e-12, "cumFunding = last tick");
});
