// metrics.js — «BTC-опционы» (Strategy One) run-metrics CORE (Phase 2b).
// PURE: no fetch / fs / DOM / Date.now — deterministic, unit-testable. Isolated from funding-arb.
//
// The run metrics the spec (pp. 11) requires — Sharpe on cycle returns, hit rate, max drawdown,
// hedge count / average hedge size, largest |Δ|-excursion before a hedge, cumulative fees/funding —
// are maintained as O(1) INCREMENTAL ACCUMULATORS (running Σ / Σ², running peak), never a stored
// series. That is exact over an unbounded run yet adds ~nothing to the per-tick persisted state
// (btc-options.json is re-serialized every tick, so a growing array would bloat it). The chart series
// live renderer-side in a bounded ring. "Cycle" = one reprice tick; cycle return = Δ net_total.
//
// NOTE on persistence: every field must survive JSON.stringify/parse. peakNet is therefore init'd to
// null (NOT -Infinity, which JSON turns into null → would coerce to 0 and corrupt drawdown on restart).

// initMetrics() → the empty accumulator, stored at state.metrics. All-JSON-safe.
export function initMetrics() {
  return {
    n: 0, // number of cycle RETURNS observed (open ticks − 1)
    lastNet: null, // previous tick's net_total (null before the first cycle)
    sumR: 0, // Σ cycle return
    sumR2: 0, // Σ cycle return²  (→ σ / Sharpe)
    hitCount: 0, // cycles with a strictly positive return
    peakNet: null, // running peak of net_total (null until the first cycle) — for max drawdown
    maxDD: 0, // max peak-to-trough drawdown of net_total
    hedgeCount: 0, // executed hedges
    sumHedgeBtc: 0, // Σ |hedge size| (BTC) → the average
    runMaxAbsDelta: 0, // running max |Total Δ| since the last hedge (excursion window)
    peakDeltaExcursion: 0, // largest |Total Δ| reached before a hedge fired
    worstMaintUtil: 0, // running max maintenance-margin utilisation (fed in 2c; read by account())
    cumFees: 0, // cumulative perp fees at the last cycle (mirror of perpState.feesCum)
    cumFunding: 0, // cumulative perp funding
  };
}

// foldCycle(acc, rec) → mutate the accumulators with ONE reprice cycle (O(1)). rec fields:
//   { net, totalDelta, decision, hedgeSizeBtc, feesCum, fundingCum, maintUtil }.
// The cycle RETURN is Δnet vs the previous tick, skipped on the very first cycle (lastNet === null).
export function foldCycle(acc, rec) {
  const net = Number.isFinite(rec.net) ? rec.net : acc.lastNet ?? 0;
  if (acc.lastNet !== null) {
    const r = net - acc.lastNet;
    acc.n++;
    acc.sumR += r;
    acc.sumR2 += r * r;
    if (r > 0) acc.hitCount++;
  }
  acc.lastNet = net;
  acc.peakNet = acc.peakNet === null || acc.peakNet === undefined ? net : Math.max(acc.peakNet, net);
  acc.maxDD = Math.max(acc.maxDD, acc.peakNet - net);
  const absDelta = Math.abs(Number.isFinite(rec.totalDelta) ? rec.totalDelta : 0);
  acc.runMaxAbsDelta = Math.max(acc.runMaxAbsDelta, absDelta);
  if (rec.decision === "HEDGE") {
    acc.hedgeCount++;
    acc.sumHedgeBtc += Math.abs(rec.hedgeSizeBtc || 0);
    acc.peakDeltaExcursion = Math.max(acc.peakDeltaExcursion, acc.runMaxAbsDelta);
    acc.runMaxAbsDelta = 0; // reset the excursion window after each hedge
  }
  acc.worstMaintUtil = Math.max(acc.worstMaintUtil || 0, rec.maintUtil || 0);
  acc.cumFees = rec.feesCum || 0;
  acc.cumFunding = rec.fundingCum || 0;
  return acc;
}

// summarize(acc) → the run-metrics read-out for the cycle-snapshot / #optMetrics panel. Pure.
// Sharpe = mean / σ of cycle returns (population σ) — a within-run consistency ratio (unitless, NOT
// annualized); 0 when σ === 0 (flat) or n === 0. Margin utilisation is a separate concern (account()).
export function summarize(acc) {
  const a = acc && typeof acc.n === "number" ? acc : initMetrics();
  const n = a.n || 0;
  const mean = n ? a.sumR / n : 0;
  const variance = n ? Math.max(0, a.sumR2 / n - mean * mean) : 0;
  const sigma = Math.sqrt(variance);
  return {
    cycles: n,
    hitRate: n ? a.hitCount / n : 0,
    sharpe: sigma > 0 ? mean / sigma : 0,
    avgCycleReturn: mean,
    maxDrawdown: a.maxDD || 0,
    hedgeCount: a.hedgeCount || 0,
    avgHedgeSizeBtc: a.hedgeCount ? a.sumHedgeBtc / a.hedgeCount : 0,
    peakDeltaExcursion: a.peakDeltaExcursion || 0,
    cumFees: a.cumFees || 0,
    cumFunding: a.cumFunding || 0,
  };
}
