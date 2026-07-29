// regime.js — «BTC-опционы» (Strategy One) IV-regime / entry-score CORE (Phase 3b).
// PURE: no fetch / fs / DOM / Date.now — deterministic, unit-testable. Isolated from funding-arb.
//
// One question for the entry advisor: is ATM implied vol currently CHEAP within its recent window?
// (Strategy One BUYS the straddle body — entries want low vol.) iv_rank positions the latest ATM IV
// inside the window's [min, max] span — 0 = at the window low, 1 = at the window high — and the
// entry screen reads favorable when iv_rank ≤ ivEntryMaxRank.
//
// Policy decisions (documented because the caller renders them verbatim):
//   • FLAT window (n ≥ 2, max === min) → iv_rank 0.5: a constant series carries no low/high signal,
//     so it sits exactly mid-range — never "favorable" under any threshold below 0.5.
//   • NULL policy: iv_rank is null with n < 2 (no span to rank against); favorable is null unless
//     BOTH n ≥ ivMinObs AND iv_rank exists — too few observations mean "no signal", never a fake
//     yes/no. atm_iv / dvol are null when the window holds no finite value of that field.
// The caller owns the clock (nowMs) and the series (observation timestamps); the input array is
// NEVER mutated (filter copies before the sort). All outputs are JSON-safe (number/boolean/null).

// computeRegime(ivSeries, { nowMs, cfg }) → { atm_iv, dvol, iv_rank, favorable, n, window_sec }.
//   ivSeries — [{ ts(ms), atmIv?, dvol? }] in ANY order; atmIv/dvol are percent-points and may be
//   null/undefined. Window = entries with nowMs − ivWindowSec·1000 < ts ≤ nowMs (strict left edge).
//   n counts window entries with a finite atmIv; atm_iv / dvol echo the NEWEST finite value of each
//   field independently (a null in a newer entry never masks an older finite one).
//   cfg defaults: ivWindowSec 86400 (24h), ivEntryMaxRank 0.35, ivMinObs 12.
export function computeRegime(ivSeries, { nowMs, cfg = {} } = {}) {
  const ivWindowSec = cfg.ivWindowSec ?? 86400;
  const ivEntryMaxRank = cfg.ivEntryMaxRank ?? 0.35;
  const ivMinObs = cfg.ivMinObs ?? 12;
  const cutoffMs = nowMs - ivWindowSec * 1000;

  // filter() copies; sort() then reorders the copy — the caller's array keeps its order.
  const window = (Array.isArray(ivSeries) ? ivSeries : [])
    .filter((e) => e && Number.isFinite(e.ts) && e.ts > cutoffMs && e.ts <= nowMs)
    .sort((a, b) => a.ts - b.ts);

  let atm_iv = null; // ascending scan → each assignment leaves the NEWEST finite value
  let dvol = null;
  let min = Infinity;
  let max = -Infinity;
  let n = 0;
  for (const e of window) {
    if (Number.isFinite(e.atmIv)) {
      n++;
      atm_iv = e.atmIv;
      if (e.atmIv < min) min = e.atmIv;
      if (e.atmIv > max) max = e.atmIv;
    }
    if (Number.isFinite(e.dvol)) dvol = e.dvol;
  }

  const iv_rank = n >= 2 ? (max === min ? 0.5 : (atm_iv - min) / (max - min)) : null;
  const favorable = n >= ivMinObs && iv_rank !== null ? iv_rank <= ivEntryMaxRank : null;

  return { atm_iv, dvol, iv_rank, favorable, n, window_sec: ivWindowSec };
}
