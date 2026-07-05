// math.js — pure port of gmx_carry_backtest/funding_spread_core.py (annualized + scan_token).
//
// SOURCE OF TRUTH for the strategy P&L math. No I/O, no DOM — unit-testable in Node and
// golden-tested against the cached spread_cache CSVs (see test/golden.test.js).
//
// SIGN + SCALE CONVENTION (verified — do not "simplify"):
//   * GMX f_long/f_short/b_long/b_short are RAW Subsquid per-second factors ALREADY divided by 1e30.
//     (The /1e30 descale happens in the fetch layer, exactly like fetch_gmx_hourly in the Python.)
//     raw f_short > 0  =>  SHORT RECEIVES funding (longs pay).  b_* >= 0 is ALWAYS a cost.
//   * HL hl_rate is a per-HOUR funding rate. hl_rate > 0 => SHORT receives (longs pay). No borrow on perps.
//   * GMX annualization multiplier is x3600x8760 (per-second -> per-year).
//     HL annualization multiplier is x8760 only (per-hour -> per-year). Never apply 3600 to HL.
//   * The ONLY explicit negation is the HL long leg: hl_long_recv = -hl_rate*8760.

export const SEC_PER_HOUR = 3600;
export const HOURS_PER_YEAR = 8760;            // 24 * 365
export const GMX_FACTOR_SCALE = 1e30;          // raw Subsquid factor scale (applied in the fetch layer)

// ---------------------------------------------------------------------------
// Stats helpers — chosen to match pandas semantics exactly.
// ---------------------------------------------------------------------------
const finite = (xs) => xs.filter((x) => Number.isFinite(x));

export function mean(xs) {
  const f = finite(xs);
  if (!f.length) return NaN;
  let s = 0;
  for (const x of f) s += x;
  return s / f.length;
}

export function median(xs) {
  const f = finite(xs).slice().sort((a, b) => a - b);
  const n = f.length;
  if (!n) return NaN;
  const m = Math.floor(n / 2);
  return n % 2 ? f[m] : (f[m - 1] + f[m]) / 2;
}

// Sample standard deviation (ddof=1) — matches pandas Series.std().
export function std(xs) {
  const f = finite(xs);
  const n = f.length;
  if (n < 2) return NaN;
  const mu = mean(f);
  let s = 0;
  for (const x of f) s += (x - mu) * (x - mu);
  return Math.sqrt(s / (n - 1));
}

export function minOf(xs) {
  let m = Infinity;
  for (const x of xs) if (Number.isFinite(x) && x < m) m = x;
  return m === Infinity ? NaN : m;
}

export function maxOf(xs) {
  let m = -Infinity;
  for (const x of xs) if (Number.isFinite(x) && x > m) m = x;
  return m === -Infinity ? NaN : m;
}

// Fraction of the series strictly > 0. Matches pandas (s > 0).mean():
// a NaN compares False (counts as not-positive) and stays in the denominator.
export function fractionPositive(xs) {
  if (!xs.length) return NaN;
  let c = 0;
  for (const x of xs) if (x > 0) c++;
  return c / xs.length;
}

// Count of times the series crosses zero, replicating
// int((s.gt(0).astype(int).diff().abs() == 1).sum()) in pandas.
export function signChanges(xs) {
  let c = 0;
  for (let i = 1; i < xs.length; i++) {
    const a = xs[i - 1] > 0 ? 1 : 0;
    const b = xs[i] > 0 ? 1 : 0;
    if (Math.abs(b - a) === 1) c++;
  }
  return c;
}

// Max drawdown as a POSITIVE fraction of notional, computed per $1 of notional
// from the annualized net-APR series. cum/peak/dd mirror the audit's ledger
// (cum = running sum of hourly return, dd = cum - peak <= 0), then normalized by
// dividing each hourly contribution by HOURS_PER_YEAR. Multiply by notional for $.
export function maxDrawdownFraction(netSeries) {
  let cum = 0;
  let peak = 0;
  let worst = 0;
  for (const n of netSeries) {
    if (!Number.isFinite(n)) continue;
    cum += n / HOURS_PER_YEAR;
    if (cum > peak) peak = cum;
    const dd = cum - peak;
    if (dd < worst) worst = dd;
  }
  return -worst; // positive fraction
}

// ---------------------------------------------------------------------------
// Core annualization — direct port of annualized() (funding_spread_core.py L342).
// Input row fields are the cached/live column names: f_long, f_short, b_long, b_short, hl_rate.
// Every returned quantity is a per-$1 annualized rate (e.g. 0.5339 == 53.39% APR).
// ---------------------------------------------------------------------------
export function annualizeRow(r) {
  const gmx_short_recv = r.f_short * SEC_PER_HOUR * HOURS_PER_YEAR;
  const gmx_long_recv = r.f_long * SEC_PER_HOUR * HOURS_PER_YEAR;
  const gmx_borrow_short = r.b_short * SEC_PER_HOUR * HOURS_PER_YEAR;
  const gmx_borrow_long = r.b_long * SEC_PER_HOUR * HOURS_PER_YEAR;
  const hl_short_recv = r.hl_rate * HOURS_PER_YEAR;
  const hl_long_recv = -r.hl_rate * HOURS_PER_YEAR;
  // Config A: short GMX + long HL ; Config B: long GMX + short HL
  const net_A = gmx_short_recv - gmx_borrow_short + hl_long_recv;
  const net_B = gmx_long_recv - gmx_borrow_long + hl_short_recv;
  return {
    gmx_short_recv,
    gmx_long_recv,
    gmx_borrow_short,
    gmx_borrow_long,
    hl_short_recv,
    hl_long_recv,
    net_A,
    net_B,
  };
}

// Build the full per-config summary block (matches the mock TWO_LEG[asset].A/.B shape).
function statsForConfig(ann, config, meanA, meanB) {
  const isA = config === "A";
  const net = ann.map((a) => (isA ? a.net_A : a.net_B));
  const gmxFund = ann.map((a) => (isA ? a.gmx_short_recv : a.gmx_long_recv));
  const gmxBorrow = ann.map((a) => (isA ? a.gmx_borrow_short : a.gmx_borrow_long));
  const hlFund = ann.map((a) => (isA ? a.hl_long_recv : a.hl_short_recv));
  return {
    netMean: mean(net),
    netMedian: median(net),
    netMin: minOf(net),
    netMax: maxOf(net),
    netStd: std(net),
    pctPos: fractionPositive(net),
    signChg: signChanges(net),
    gmxFund: mean(gmxFund),
    gmxBorrow: mean(gmxBorrow),
    hlFund: mean(hlFund),
    ddPct: maxDrawdownFraction(net),
    meanA,
    meanB,
    _net: net, // hourly net-APR series, kept for chart/P&L building; not part of the render contract
  };
}

// ---------------------------------------------------------------------------
// scanTwoLeg — port of scan_token(): pick config by argmax of the whole-window MEAN
// of net_A vs net_B (ties -> A), return both configs' stat blocks + the chosen one.
// `meta` carries instrument metadata passed straight through (token, addresses, etc.).
// ---------------------------------------------------------------------------
export function scanTwoLeg(rows, meta = {}, { minRows = 24 } = {}) {
  if (!rows || rows.length < minRows) return null; // default: need >= 24 overlapping hours
  const ann = rows.map(annualizeRow);
  const meanA = mean(ann.map((a) => a.net_A));
  const meanB = mean(ann.map((a) => a.net_B));
  const chosen = meanA >= meanB ? "A" : "B";
  const A = statsForConfig(ann, "A", meanA, meanB);
  const B = statsForConfig(ann, "B", meanA, meanB);
  const last = rows[rows.length - 1];
  return {
    token: meta.token,
    ...meta,
    hours: rows.length,
    first: rows[0]?.ts ?? null,
    last: last?.ts ?? null,
    chosen,
    meanA,
    meanB,
    A,
    B,
    // raw factors of the most recent row — for the transparency panels + inspector
    raw: {
      f_long: last.f_long,
      f_short: last.f_short,
      b_long: last.b_long,
      b_short: last.b_short,
      hl_rate: last.hl_rate,
      hl_premium: last.hl_premium,
    },
    // chosen-config net series (used by charts / P&L path)
    seriesA: A._net,
    seriesB: B._net,
    net: chosen === "A" ? A._net : B._net,
  };
}

// ---------------------------------------------------------------------------
// scanOneLeg — GMX one-leg carry: short the asset with collateral in the asset.
// net = gmx_short_recv - gmx_borrow_short (audit single-leg identity). Matches the
// mock ONE_LEG[market] shape.
// ---------------------------------------------------------------------------
export function scanOneLeg(rows, meta = {}, { minRows = 24 } = {}) {
  if (!rows || rows.length < minRows) return null;
  const ann = rows.map(annualizeRow);
  const fund = ann.map((a) => a.gmx_short_recv);
  const borrow = ann.map((a) => a.gmx_borrow_short);
  const net = ann.map((a) => a.gmx_short_recv - a.gmx_borrow_short);
  const fShortPos = rows.map((r) => (r.f_short > 0 ? 1 : 0)); // short receives => longs pay
  const last = rows[rows.length - 1];
  return {
    token: meta.token,
    ...meta,
    hours: rows.length,
    first: rows[0]?.ts ?? null,
    last: last?.ts ?? null,
    netMean: mean(net),
    netMedian: median(net),
    netMin: minOf(net),
    netMax: maxOf(net),
    fundMean: mean(fund),
    fundMedian: median(fund),
    fundMin: minOf(fund),
    fundMax: maxOf(fund),
    borrowMean: mean(borrow),
    borrowMedian: median(borrow),
    borrowMax: maxOf(borrow),
    pctPos: fractionPositive(net),
    flips: signChanges(net),
    longsPayPct: mean(fShortPos),
    shortsPayPct: 1 - mean(fShortPos),
    ddPct: maxDrawdownFraction(net),
    raw: {
      f_long: last.f_long,
      f_short: last.f_short,
      b_long: last.b_long,
      b_short: last.b_short,
    },
    net,
    fund,
    borrow,
  };
}

// ---------------------------------------------------------------------------
// pnlPath — closed-window equity path from an annualized net-APR series.
// Per audit: $/hr = (net_APR/8760)*notional ; cum = running sum ; dd = cum - peak.
// Used for the trailing historical curve and the golden P&L cross-check. The FORWARD
// paper engine (paper.js) uses per-second live factors instead — this is the historical view.
// ---------------------------------------------------------------------------
export function pnlPath(netSeries, notional) {
  const perHr = [];
  const cum = [];
  const dd = [];
  let s = 0;
  let peak = 0;
  for (const n of netSeries) {
    const h = (n / HOURS_PER_YEAR) * notional;
    perHr.push(h);
    s += h;
    cum.push(s);
    if (s > peak) peak = s;
    dd.push(s - peak);
  }
  return { perHr, cum, dd, total: cum.length ? cum[cum.length - 1] : 0 };
}
