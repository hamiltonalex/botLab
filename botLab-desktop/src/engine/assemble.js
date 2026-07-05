// assemble.js — turns live snapshots + trailing history into the EXACT render-contract shapes the
// reused UI consumes (TWO_LEG[asset], ONE_LEG[key], SCANNER rows) plus per-selection chart series.
// The renderer stays thin: it assigns these and calls its unchanged render/draw functions.

import { annualizeRow, scanTwoLeg, scanOneLeg, mean, median, maxDrawdownFraction, HOURS_PER_YEAR } from "./math.js";

// Slice the trailing `winDays` of an hourly frame by TIMESTAMP (calendar), not by array index:
// inner-join holes must not compress the time axis or smuggle out-of-window rows in (audit M24).
// Shared by the chart series AND the per-instrument stat entries so every panel that claims the
// selected window really computes over the same rows.
export function sliceWindow(frame, winDays) {
  if (!frame || !frame.length) return [];
  if (!Number.isFinite(winDays)) return frame;
  const endTs = frame[frame.length - 1].tsHour;
  if (!Number.isFinite(endTs)) return frame.slice(Math.max(0, frame.length - winDays * 24));
  const minTs = endTs - winDays * 86400;
  return frame.filter((r) => Number.isFinite(r.tsHour) && r.tsHour > minTs);
}

// Stat entries for short windows accept fewer rows than the 24h full-frame minimum: a 1-day window
// with any hole would otherwise stay "loading" forever, while the chart series happily renders.
const ENTRY_MIN_ROWS = 6;

// Sane upper bound on a live Hyperliquid per-hour funding rate. HL funding is per-hour and
// protocol-capped near ±4%/hr; a finite value at/above this signals a wrong-scale/units source.
const HL_RATE_SANE_MAX = 0.05;

// Strip the internal net series out of a scan config block before sending over IPC.
function cleanBlock(b) {
  if (!b) return null;
  const { _net, ...rest } = b;
  return rest;
}

// ---- current live snapshot (profitability NOW) for one instrument ----
// gmxCanon = gmxMarketToCanonical(...) ; hlCanon = hlCtxToCanonical(...).
// For ONE-LEG instruments (no inst.hlCoin) there is no HL leg: hl_rate is a true 0 and hlCanon (if
// passed, matched by token) is used for PRICE CONTEXT only. For TWO-LEG instruments a missing HL
// context yields hl_rate = NaN so the accrual engine refuses the interval instead of silently
// pricing the HL leg at zero (audit M10).
export function buildSnapshot(inst, gmxCanon, hlCanon) {
  if (!gmxCanon) return null;
  const isOneLeg = !inst.hlCoin;
  const f = gmxCanon.factors;
  const row = {
    ...f,
    hl_rate: isOneLeg ? 0 : hlCanon ? hlCanon.hl_rate : NaN,
    hl_premium: isOneLeg ? 0 : hlCanon ? hlCanon.hl_premium : NaN,
  };
  const a = annualizeRow(row);
  const oneLegNet = a.gmx_short_recv - a.gmx_borrow_short;
  const chosen = a.net_A >= a.net_B ? "A" : "B";
  // HL plausibility: a two-leg HL rate that is FINITE but outside the sane per-hour band is a
  // wrong-scale/units signal — pause accrual (mirrors the GMX netRate identity gate). A MISSING
  // (NaN) HL rate is NOT a gate failure: accrue() simply refuses that interval until HL returns.
  const hlImplausible = !isOneLeg && Number.isFinite(row.hl_rate) && Math.abs(row.hl_rate) >= HL_RATE_SANE_MAX;
  const required = isOneLeg
    ? [row.f_short, row.b_short]
    : [row.f_long, row.f_short, row.b_long, row.b_short, row.hl_rate];
  const dataComplete = required.every(Number.isFinite);
  const gateOk = gmxCanon.gate.ok && !hlImplausible;
  return {
    key: inst.key,
    price: hlCanon ? hlCanon.markPx : null,
    raw: row,
    oi: { longUsd: gmxCanon.oiLongUsd, shortUsd: gmxCanon.oiShortUsd },
    hlMaxLev: !isOneLeg && hlCanon ? hlCanon.maxLev : null,
    ann: a,
    netA: a.net_A,
    netB: a.net_B,
    oneLegNet,
    chosen,
    gateOk,
    dataComplete,
    accrualOk: gateOk && dataComplete,
  };
}

// ---- windowed summaries merged with the live snapshot (mock TWO_LEG[asset] shape) ----
// winDays slices the stats to the SELECTED window so the strategy panel / scanner match the hero
// and charts (they were silently full-frame 365d before — audit #3 W2); omit for full-frame.
export function buildTwoLegEntry(inst, frame, snap, winDays) {
  const rows = Number.isFinite(winDays) ? sliceWindow(frame, winDays) : frame || [];
  const minRows = Number.isFinite(winDays) ? ENTRY_MIN_ROWS : 25;
  const s = rows.length >= minRows ? scanTwoLeg(rows, { token: inst.token }, { minRows }) : null;
  const A = s ? cleanBlock(s.A) : null;
  const B = s ? cleanBlock(s.B) : null;
  return {
    price: snap?.price ?? null,
    hlCoin: inst.hlCoin,
    hlMaxLev: snap?.hlMaxLev ?? inst.hlMaxLev,
    gmxName: inst.gmxName,
    gmxAddr: inst.gmxAddr,
    gmxChain: inst.chain,
    raw: snap?.raw ?? null,
    oi: snap?.oi ?? null, // null (not zeros) when no live snapshot — renderer shows a placeholder
    chosen: s?.chosen ?? snap?.chosen ?? "A",
    A,
    B,
    hours: s?.hours ?? 0,
    first: s?.first ?? null,
    last: s?.last ?? null,
    // the window these stats were computed over — entries carry no forKey, so the renderer labels
    // the stats panel from THIS stamp (not the live selector) and can never mislabel a stale push
    winDays: Number.isFinite(winDays) ? winDays : null,
  };
}

// ---- windowed one-leg summary merged with live snapshot (mock ONE_LEG[key] shape) ----
export function buildOneLegEntry(inst, frame, snap, winDays) {
  const rows = Number.isFinite(winDays) ? sliceWindow(frame, winDays) : frame || [];
  const minRows = Number.isFinite(winDays) ? ENTRY_MIN_ROWS : 25;
  const s = rows.length >= minRows ? scanOneLeg(rows, { token: inst.token }, { minRows }) : null;
  return {
    label: inst.label,
    asset: inst.token,
    price: snap?.price ?? null,
    chain: inst.chain,
    gmxName: inst.gmxName,
    gmxAddr: inst.gmxAddr,
    raw: snap?.raw ?? null,
    netMean: s?.netMean ?? null,
    netMedian: s?.netMedian ?? null,
    netMin: s?.netMin ?? null,
    netMax: s?.netMax ?? null,
    fundMean: s?.fundMean ?? null,
    fundMedian: s?.fundMedian ?? null,
    fundMin: s?.fundMin ?? null,
    fundMax: s?.fundMax ?? null,
    borrowMean: s?.borrowMean ?? null,
    borrowMedian: s?.borrowMedian ?? null,
    borrowMax: s?.borrowMax ?? null,
    pctPos: s?.pctPos ?? null,
    flips: s?.flips ?? null,
    longsPayPct: s?.longsPayPct ?? null,
    shortsPayPct: s?.shortsPayPct ?? null,
    ddPct: s?.ddPct ?? null,
    oi: snap?.oi ?? null,
    hours: s?.hours ?? 0,
    winDays: Number.isFinite(winDays) ? winDays : null,
  };
}

// ---- min-set scanner ranking (real), ranked by MEDIAN net APR (robust to spikes) ----
export function buildScanner(twoLegByKey) {
  const rows = [];
  for (const [key, e] of Object.entries(twoLegByKey)) {
    const cfg = e.chosen || "A";
    const blk = e[cfg];
    if (!blk) continue;
    const oiTot = e.oi ? e.oi.longUsd + e.oi.shortUsd : 0;
    const thin = oiTot < 1e6; // < $1M total OI => thin
    rows.push({ s: key, c: cfg, med: blk.netMedian, mean: blk.netMean, pct: blk.pctPos, sc: blk.signChg, st: thin ? "thin" : "trad", h: e.hours, winDays: e.winDays });
  }
  rows.sort((a, b) => (b.med ?? -Infinity) - (a.med ?? -Infinity));
  rows.forEach((r, i) => (r.r = i + 1));
  return rows;
}

// ---- per-selection chart series (real), computed from the trailing frame ----
// Returns shapes matching the renderer's build* consumers.
export function buildSeries(frame, strat, cfg, winDays, priceDaily = []) {
  if (!frame || !frame.length) return null;
  const haveTs = Number.isFinite(frame[frame.length - 1].tsHour);
  const rows = sliceWindow(frame, winDays);
  if (!rows.length) return null;
  const ann = rows.map(annualizeRow);
  const isA = cfg === "A";
  const pick = (a) => {
    if (strat === "one") return { net: a.gmx_short_recv - a.gmx_borrow_short, gmxFund: a.gmx_short_recv, gmxBorrow: a.gmx_borrow_short, hlFund: 0 };
    return isA
      ? { net: a.net_A, gmxFund: a.gmx_short_recv, gmxBorrow: a.gmx_borrow_short, hlFund: a.hl_long_recv }
      : { net: a.net_B, gmxFund: a.gmx_long_recv, gmxBorrow: a.gmx_borrow_long, hlFund: a.hl_short_recv };
  };
  const comp = ann.map(pick);
  const startTs = haveTs ? rows[0].tsHour : null;
  const endTs = haveTs ? rows[rows.length - 1].tsHour : null;
  // Adaptive chart granularity: hourly buckets for short windows (<=7d) so 1d/7d have real
  // resolution (daily bucketing would give only 1/7 points); daily buckets for longer windows.
  const bucketSec = winDays <= 7 ? 3600 : 86400;
  const bucketUnit = winDays <= 7 ? "hour" : "day";
  const bucketsPerHour = 3600 / bucketSec; // 1 for hourly, 1/24 for daily
  const bucketIdx = (i) => (haveTs ? Math.floor((rows[i].tsHour - startTs) / bucketSec) : Math.floor(i * bucketsPerHour));
  const nBuckets = Math.max(1, bucketIdx(rows.length - 1) + 1);
  // Day-span of the window, used ONLY for hero annualization (independent of chart bucketing; D9).
  const nDays = haveTs ? Math.max(1, Math.floor((endTs - startTs) / 86400) + 1) : Math.max(1, Math.round(rows.length / 24));

  // equityBaseCum: per-$1 cumulative return per bucket (net/8760 per hour), length nBuckets+1, [0]=0.
  const equityBaseCum = new Array(nBuckets + 1).fill(undefined);
  equityBaseCum[0] = 0;
  const spreadBuckets = Array.from({ length: nBuckets }, () => []);
  let run = 0;
  for (let i = 0; i < comp.length; i++) {
    run += comp[i].net / HOURS_PER_YEAR;
    const b = Math.min(nBuckets - 1, bucketIdx(i));
    equityBaseCum[b + 1] = run;
    spreadBuckets[b].push(comp[i].net);
  }
  // fill gaps forward (buckets with no data carry the previous cumulative)
  for (let b = 1; b <= nBuckets; b++) if (equityBaseCum[b] === undefined) equityBaseCum[b] = equityBaseCum[b - 1];
  const spreadDaily = spreadBuckets.map((b) => (b.length ? mean(b) : 0));

  // legs: adaptive grouping into a small number of readable stacked bars (month/week/day/6h by window).
  let legGroupSec, legUnit;
  if (winDays >= 90) { legGroupSec = 30 * 86400; legUnit = "мес"; }
  else if (winDays >= 21) { legGroupSec = 7 * 86400; legUnit = "нед"; }
  else if (winDays >= 2) { legGroupSec = 86400; legUnit = "дн"; }
  else { legGroupSec = 6 * 3600; legUnit = "6ч"; }
  const legIdx = (i) => (haveTs ? Math.floor((rows[i].tsHour - startTs) / legGroupSec) : Math.floor((i * 3600) / legGroupSec));
  const nLegs = Math.max(1, legIdx(rows.length - 1) + 1);
  const legBuckets = Array.from({ length: nLegs }, () => ({ gmxFund: [], gmxBorrow: [], hlFund: [] }));
  for (let i = 0; i < comp.length; i++) {
    const m = Math.min(nLegs - 1, legIdx(i));
    legBuckets[m].gmxFund.push(comp[i].gmxFund);
    legBuckets[m].gmxBorrow.push(comp[i].gmxBorrow);
    legBuckets[m].hlFund.push(comp[i].hlFund);
  }
  const legsMonthly = legBuckets.map((b) => ({ gmxFund: mean(b.gmxFund) || 0, gmxBorrow: mean(b.gmxBorrow) || 0, hlFund: mean(b.hlFund) || 0 }));

  // price context: a SINGLE reference series (Binance daily closes). We do NOT have per-venue
  // (GMX-oracle vs HL-mark) history, so we do not fabricate two lines or a measured basis — the
  // chart is labeled "reference (Binance)" and the cross-venue delta is a P3 item (audit).
  const px = priceDaily.length ? priceDaily.slice(-Math.min(180, nDays)) : [];
  const price = { ref: px.slice(), level: px.length ? px[px.length - 1] : 0 };

  // rawRows: the last 120 REAL hourly rows with derived APR fields (raw-data inspector).
  // Per-hour prices are not joined here; price is null (rendered as "—"), never a fake constant.
  const lastN = rows.slice(-120).reverse(); // newest first (matches the inspector)
  const annLast = lastN.map(annualizeRow);
  const rawRows = lastN.map((r, i) => {
    const a = annLast[i];
    const net = strat === "one" ? a.gmx_short_recv - a.gmx_borrow_short : isA ? a.net_A : a.net_B;
    return {
      ts: r.ts,
      price: null,
      f_long: r.f_long,
      f_short: r.f_short,
      b_long: r.b_long,
      b_short: r.b_short,
      hl_rate: r.hl_rate,
      gmxFundShort: a.gmx_short_recv,
      gmxFundLong: a.gmx_long_recv,
      gmxBorShort: a.gmx_borrow_short,
      gmxBorLong: a.gmx_borrow_long,
      hlShort: a.hl_short_recv,
      hlLong: a.hl_long_recv,
      net,
    };
  });

  return {
    equityBaseCum,
    spreadDaily,
    legsMonthly,
    price,
    rawRows,
    nDays,
    nBuckets,
    bucketUnit,
    legUnit,
    nLegs,
    hours: rows.length,
    netMedian: median(comp.map((c) => c.net)),
    // max drawdown of THIS window's net series, per $1 of notional — the hero shows this next to
    // the windowed P&L/APR (it used to show the full-frame 365d ddPct there — audit #3 W1)
    ddPct: maxDrawdownFraction(comp.map((c) => c.net)),
  };
}
