// rv.js — «OTM-сканер» realized-volatility / impulse / trend CORE (S0).
// PURE: no fetch / fs / DOM / Date.now — deterministic, unit-testable. Isolated from funding-arb and
// from the bot-2 engine (plan §3.1). Input: 1h candles of BTC-PERPETUAL as an index proxy (the perp
// tracks the BTC_USDC index tightly; settlement math NEVER uses this — it uses delivery prices).
//
// Conventions (plan §5.1): percents are percent-points; log returns; RV is annualized close-to-close
// over CLOSED bars only (the tradingview feed's last bar is the hour in progress — always dropped);
// completeness is judged on CONSECUTIVE pairs (a gap contributes no return and no fake bar); the
// caller owns the clock (nowMs) and the candle ring.

const num = (x) => (Number.isFinite(x) ? x : null);

export const HOUR_MS = 3600000;
const YEAR_MS = 365 * 86400000;

// Parallel tradingview arrays → canonical ascending candles [{ ts, open, high, low, close }].
// Non-finite rows are dropped; duplicate ts keeps the LAST occurrence (a refreshed bar wins).
export function tvToCandles(tv) {
  const ticks = tv?.ticks ?? [];
  const byTs = new Map();
  for (let i = 0; i < ticks.length; i++) {
    const ts = num(ticks[i]);
    const open = num(tv.open?.[i]);
    const high = num(tv.high?.[i]);
    const low = num(tv.low?.[i]);
    const close = num(tv.close?.[i]);
    if (ts == null || close == null) continue;
    byTs.set(ts, { ts, open, high, low, close });
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

// Only bars fully closed by nowMs (ts is the bar OPEN time).
export function closedCandles(candles, nowMs, barMs = HOUR_MS) {
  return (candles ?? []).filter((c) => c && Number.isFinite(c.ts) && c.ts + barMs <= nowMs);
}

// Annualized close-to-close realized vol (percent) over the last `bars` bar-slots before nowMs.
// Returns { rvPct|null, nPairs, need, complete }. Pairs are CONSECUTIVE closed bars (dt === barMs);
// null when pairs < minCompleteness·(bars−1) — too many holes mean "no signal", never a fake number.
export function realizedVolPct(candles, { bars, nowMs, barMs = HOUR_MS, minCompleteness = 0.9 } = {}) {
  const need = Math.max(1, bars - 1);
  const cutoff = nowMs - bars * barMs;
  const win = closedCandles(candles, nowMs, barMs).filter((c) => c.ts >= cutoff);
  const returns = [];
  for (let i = 1; i < win.length; i++) {
    if (win[i].ts - win[i - 1].ts !== barMs) continue; // a hole yields no return
    if (win[i - 1].close > 0 && win[i].close > 0) returns.push(Math.log(win[i].close / win[i - 1].close));
  }
  const complete = returns.length / need;
  if (returns.length < 2 || complete < minCompleteness) {
    return { rvPct: null, nPairs: returns.length, need, complete };
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const varSum = returns.reduce((s, r) => s + (r - mean) * (r - mean), 0);
  const sd = Math.sqrt(varSum / (returns.length - 1)); // sample stdev per bar
  const rvPct = sd * Math.sqrt(YEAR_MS / barMs) * 100;
  return { rvPct, nPairs: returns.length, need, complete };
}

// Last EMA(period) over values (SMA-seeded). null while fewer than `period` values exist.
export function emaLast(values, period) {
  const v = (values ?? []).filter((x) => Number.isFinite(x));
  if (!Number.isFinite(period) || period < 1 || v.length < period) return null;
  let ema = v.slice(0, period).reduce((s, x) => s + x, 0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < v.length; i++) ema = v[i] * k + ema * (1 - k);
  return ema;
}

// The one bundle the scanner conditions consume (plan §5.1). Any missing input yields null in that
// field — conditions.js maps null → unknown; nothing here guesses.
//   rv7dPct/rv3dPct — annualized RV over 7д/3д of 1h bars;
//   sigma1dPct      — daily σ in % of price (rv7d/√365);
//   dP24hPct        — close-to-close move over the last 24h of CLOSED bars;
//   impulse         — |dP24hPct| / sigma1dPct;  direction — "call" | "put" | null (side of the move);
//   ema             — EMA(emaPeriod) of closed closes;  lastClose/lastTs — the newest closed bar.
export function computeRvBundle(candles, nowMs, { barMs = HOUR_MS, emaPeriod = 20, rv7Bars = 168, rv3Bars = 72, minCompleteness = 0.9 } = {}) {
  const closed = closedCandles(candles, nowMs, barMs);
  const rv7 = realizedVolPct(closed, { bars: rv7Bars, nowMs, barMs, minCompleteness });
  const rv3 = realizedVolPct(closed, { bars: rv3Bars, nowMs, barMs, minCompleteness });
  const sigma1dPct = rv7.rvPct != null ? rv7.rvPct / Math.sqrt(365) : null;

  const last = closed.length ? closed[closed.length - 1] : null;
  let dP24hPct = null;
  if (last) {
    const targetTs = last.ts - 24 * barMs;
    // exact bar preferred; else the nearest within 2 bar-slots (a small hole must not kill the signal)
    let ref = null;
    for (const c of closed) {
      if (Math.abs(c.ts - targetTs) <= 2 * barMs && (!ref || Math.abs(c.ts - targetTs) < Math.abs(ref.ts - targetTs))) ref = c;
    }
    if (ref && ref.close > 0) dP24hPct = (last.close / ref.close - 1) * 100;
  }
  const impulse = dP24hPct != null && sigma1dPct != null && sigma1dPct > 0 ? Math.abs(dP24hPct) / sigma1dPct : null;
  const direction = dP24hPct == null || dP24hPct === 0 ? null : dP24hPct > 0 ? "call" : "put";
  const ema = emaLast(closed.map((c) => c.close), emaPeriod);

  return {
    rv7dPct: rv7.rvPct,
    rv3dPct: rv3.rvPct,
    sigma1dPct,
    dP24hPct,
    impulse,
    direction,
    ema,
    emaPeriod,
    lastClose: last ? last.close : null,
    lastTs: last ? last.ts : null,
    bars: { n7: rv7.nPairs, need7: rv7.need, complete7: rv7.complete, n3: rv3.nPairs, need3: rv3.need, complete3: rv3.complete },
  };
}
