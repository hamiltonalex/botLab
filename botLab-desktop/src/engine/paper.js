// paper.js — forward paper-trading funding/borrow accrual engine. It prices the modeled carry from
// real exchange rates; execution effects, liquidation and account reconciliation remain outside
// this Phase-1 ledger and must not be inferred from its P&L.
//
//   * GMX funding + borrow accrue CONTINUOUSLY: dPnl = factorPerSec * elapsedSeconds * notional.
//   * HL funding settles DISCRETELY at the top of each hour: a held position pays/receives
//     hl_rate * notional once per crossed hour boundary (close mid-hour => that hour not charged).
//   * Round-trip fees (open+close) are modeled once and netted against gross funding P&L.
//
// No orders, no keys — this simulates the ledger a real position WOULD produce from live rates.

import { SEC_PER_HOUR, HOURS_PER_YEAR } from "./math.js";

const HOUR_MS = SEC_PER_HOUR * 1000;
let idCounter = 0;

// Per-second GMX net factor and per-hour HL settlement sign for a given strategy/config.
export function legModel(strategy, config) {
  if (strategy === "one") return { gmxSide: "short", hlPerHourSign: 0 };
  return config === "A"
    ? { gmxSide: "short", hlPerHourSign: -1 } // A: short GMX (recv funding, pay borrow) + long HL (pays +hl_rate)
    : { gmxSide: "long", hlPerHourSign: +1 }; // B: long GMX + short HL (receives +hl_rate)
}

function gmxNetPerSec(snap, gmxSide) {
  return gmxSide === "short" ? snap.f_short - snap.b_short : snap.f_long - snap.b_long;
}

// Create a new paper position at t0. `costs` is the resolved round-trip cost in $ (see costs.js).
// costBreakdown/openMarkPx are optional t0 snapshots for the transaction ledger: the cost model is
// user-editable and live prices move on, so both must be frozen at open or not shown at all.
export function openPosition({ strategy, instrumentKey, config = null, capital, leverage, nowMs, meta = {}, roundTripCost = 0, costBreakdown = null, openMarkPx = null }) {
  const notional = capital * leverage;
  const t0 = nowMs;
  return {
    id: `p${++idCounter}_${t0}`,
    createdAt: t0,
    strategy, // 'two' | 'one'
    instrumentKey, // e.g. 'ETH' or 'ETH-Avax'
    config: strategy === "two" ? config : null,
    capital,
    leverage,
    notional,
    roundTripCost,
    costBreakdown,
    openMarkPx,
    meta, // { gmxName, hlCoin, chain, token, ... } for display + snapshot lookup
    status: "open",
    closedAt: null,
    lastAccrualAt: t0,
    cumFunding: 0, // gross cumulative $ from funding/borrow
    peakCum: 0,
    maxDrawdown: 0, // most-negative (cum - peak), <= 0
    equityCurve: [{ t: t0, cum: 0, equityGross: capital, equityNet: capital - roundTripCost }],
    accruals: [], // audit ledger of each accrual step
  };
}

// Shared: apply one signed P&L delta to the running position state and emit ledger/curve points.
function applyDelta(position, nowMs, entry) {
  position.cumFunding += entry.dPnl;
  if (position.cumFunding > position.peakCum) position.peakCum = position.cumFunding;
  const dd = position.cumFunding - position.peakCum;
  if (dd < position.maxDrawdown) position.maxDrawdown = dd;
  position.lastAccrualAt = nowMs;
  const point = {
    t: nowMs,
    cum: position.cumFunding,
    equityGross: position.capital + position.cumFunding,
    equityNet: position.capital + position.cumFunding - position.roundTripCost,
  };
  position.equityCurve.push(point);
  position.accruals.push({ t: nowMs, cum: position.cumFunding, ...entry });
  return point;
}

// Accrue one interval from position.lastAccrualAt -> nowMs using the current live snapshot.
// snapshot = canonical current factors { f_long, f_short, b_long, b_short, hl_rate } for the instrument.
// opts.maxDtSec caps how far back a single live-rate step may reach: pricing a long offline gap at
// the CURRENT instantaneous rate is wrong (gaps must be backfilled from history via accrueFromRows);
// anything beyond the cap is recorded as gapSkippedSec in the ledger instead of being mispriced.
// Returns the new equity point, or null if the snapshot is invalid (interval is carried forward).
export function accrue(position, snapshot, nowMs, opts = {}) {
  if (position.status !== "open") return null;
  if (nowMs <= position.lastAccrualAt) return null;
  const { f_long, f_short, b_long, b_short, hl_rate } = snapshot || {};
  const needed = position.strategy === "one" ? [f_short, b_short] : [f_long, f_short, b_long, b_short, hl_rate];
  if (needed.some((x) => !Number.isFinite(x))) return null; // don't advance time on bad data

  const { gmxSide, hlPerHourSign } = legModel(position.strategy, position.config);
  let dtSec = (nowMs - position.lastAccrualAt) / 1000;
  let gapSkippedSec = 0;
  let accrueFromMs = position.lastAccrualAt;
  const maxDtSec = Number.isFinite(opts.maxDtSec) ? opts.maxDtSec : Infinity;
  if (dtSec > maxDtSec) {
    gapSkippedSec = dtSec - maxDtSec;
    dtSec = maxDtSec;
    accrueFromMs = nowMs - maxDtSec * 1000;
  }

  // GMX: continuous accrual over elapsed seconds.
  const gmxPerSec = gmxNetPerSec(snapshot, gmxSide);
  const dPnlGmx = gmxPerSec * dtSec * position.notional;
  // Ledger split: funding priced from its own factor; borrow as the EXACT complement so the pair
  // always sums bit-for-bit to the dPnlGmx every existing consumer/test asserts on.
  const fundingUsd = (gmxSide === "short" ? f_short : f_long) * dtSec * position.notional;
  const borrowUsd = dPnlGmx - fundingUsd;

  // HL: one discrete settlement per crossed top-of-hour boundary, using the current rate estimate.
  let hlSettlements = 0;
  if (hlPerHourSign !== 0 && Number.isFinite(hl_rate)) {
    const fromHour = Math.floor(accrueFromMs / HOUR_MS);
    const toHour = Math.floor(nowMs / HOUR_MS);
    hlSettlements = Math.max(0, toHour - fromHour);
  }
  const dPnlHl = hlSettlements * hlPerHourSign * (hl_rate || 0) * position.notional;

  return applyDelta(position, nowMs, {
    source: "live",
    dtSec,
    gapSkippedSec,
    gmxPerSec,
    dPnlGmx,
    fundingUsd,
    borrowUsd,
    hlSettlements,
    dPnlHl,
    dPnl: dPnlGmx + dPnlHl,
    markPx: Number.isFinite(opts.markPx) ? opts.markPx : null, // best-effort mark at accrual time
  });
}

// Accrue an offline gap from HISTORICAL hourly rows (canonical frame rows: tsHour in epoch seconds,
// f_long/f_short/b_long/b_short per-second factors, hl_rate hourly). Each hour is priced at ITS OWN
// recorded rates: GMX continuously over the overlapped seconds, HL as one settlement per fully
// crossed top-of-hour boundary. Advances lastAccrualAt hour by hour; the remainder (beyond the last
// available row) is left for the live accrue(). Returns a summary of what was applied.
export function accrueFromRows(position, rows, nowMs) {
  if (position.status !== "open" || !rows || !rows.length) return { hoursApplied: 0, gapSkippedSec: 0 };
  const { gmxSide, hlPerHourSign } = legModel(position.strategy, position.config);
  let hoursApplied = 0;
  let gapSkippedSec = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.tsHour)) continue;
    const hourStartMs = r.tsHour * 1000;
    const hourEndMs = hourStartMs + HOUR_MS;
    if (hourEndMs <= position.lastAccrualAt) continue; // already accrued
    const start = Math.max(position.lastAccrualAt, hourStartMs);
    const end = Math.min(hourEndMs, nowMs);
    if (end <= start) continue;
    const needed = position.strategy === "one" ? [r.f_short, r.b_short] : [r.f_long, r.f_short, r.b_long, r.b_short, r.hl_rate];
    if (needed.some((x) => !Number.isFinite(x))) continue; // hole in history: skip this hour
    // If an earlier row was missing/invalid, advancing into this valid hour permanently closes that
    // interval. Record it on the ledger instead of silently losing it from the account summary.
    const uncoveredSec = Math.max(0, (start - position.lastAccrualAt) / 1000);
    gapSkippedSec += uncoveredSec;
    const dtSec = (end - start) / 1000;
    const gmxPerSec = gmxNetPerSec(r, gmxSide);
    const dPnlGmx = gmxPerSec * dtSec * position.notional;
    // Ledger split (see accrue): borrow is the exact complement of the funding part.
    const fundingUsd = (gmxSide === "short" ? r.f_short : r.f_long) * dtSec * position.notional;
    const borrowUsd = dPnlGmx - fundingUsd;
    // The hour's settlement lands on its closing boundary; count it only if we crossed it.
    const hlSettlements = hlPerHourSign !== 0 && end === hourEndMs ? 1 : 0;
    const dPnlHl = hlSettlements * hlPerHourSign * (r.hl_rate || 0) * position.notional;
    applyDelta(position, end, {
      source: "history",
      dtSec,
      gapSkippedSec: uncoveredSec,
      gmxPerSec,
      dPnlGmx,
      fundingUsd,
      borrowUsd,
      hlSettlements,
      dPnlHl,
      dPnl: dPnlGmx + dPnlHl,
    });
    hoursApplied++;
    if (end >= nowMs) break;
  }
  return { hoursApplied, gapSkippedSec };
}

// Settle a position up to nowMs with a bounded live step. If the elapsed gap exceeds capSec, the
// whole-hour part of the gap is priced from HISTORICAL rows first (each hour at its own recorded
// rates); only the remainder is priced at the current live snapshot, still capped by capSec.
// This keeps EVERY accrual path (poll tick, poll-interval change, close) free of the cap dead
// zone: a gap the live step can't cover is silently dropped ONLY when no history exists for it.
// Without this, shrinking the poll interval mid-session (15m -> 1m) or a laptop sleep/wake shrank
// or outgrew the live cap and lost real funding (incl. HL top-of-hour settlements) to
// gapSkippedSec until the next full restart (gap backfill used to be boot-only).
export function settlePosition(position, rows, snapshotRaw, nowMs, capSec, opts = {}) {
  if (position.status !== "open") return false;
  let changed = false;
  const gapSec = (nowMs - position.lastAccrualAt) / 1000;
  if (Number.isFinite(capSec) && gapSec > capSec && rows && rows.length) {
    if (accrueFromRows(position, rows, nowMs).hoursApplied > 0) changed = true;
  }
  if (snapshotRaw && accrue(position, snapshotRaw, nowMs, { maxDtSec: capSec, markPx: opts.markPx })) changed = true;
  return changed;
}

// Explicitly close an interval that cannot be priced from either history or a valid live snapshot.
// Advancing with a zero delta is acceptable only when the missing duration is recorded: callers
// (notably closePaper) can remain operable during an outage without silently erasing ledger time.
export function recordUnpricedGap(position, nowMs, reason = "required live data unavailable") {
  if (position.status !== "open" || nowMs <= position.lastAccrualAt) return null;
  const gapSkippedSec = (nowMs - position.lastAccrualAt) / 1000;
  return applyDelta(position, nowMs, {
    source: "skipped",
    reason,
    dtSec: 0,
    gapSkippedSec,
    gmxPerSec: 0,
    dPnlGmx: 0,
    hlSettlements: 0,
    dPnlHl: 0,
    dPnl: 0,
  });
}

export function closePosition(position, nowMs) {
  if (position.status === "open") {
    position.status = "closed";
    position.closedAt = nowMs;
  }
  return position;
}

// Annualization is meaningless below this horizon (it just multiplies noise/one-off costs by
// 8760/hours); the UI shows "—" until enough hours have accrued.
export const APR_MIN_HOURS = 24;

// Realized summary (used by the hero + forward equity panel).
export function positionSummary(position) {
  const grossPnl = position.cumFunding;
  const netPnl = grossPnl - position.roundTripCost;
  const hoursElapsed = (position.lastAccrualAt - position.createdAt) / HOUR_MS;
  const ret = position.capital ? netPnl / position.capital : 0;
  // aprGross annualizes ONLY the funding flow (a rate, meaningful to annualize); apr additionally
  // amortizes the one-off round-trip cost — reliable only once enough hours have passed.
  const aprGross = hoursElapsed > 0 ? (grossPnl / position.capital) * (HOURS_PER_YEAR / hoursElapsed) : 0;
  const apr = hoursElapsed > 0 ? (netPnl / position.capital) * (HOURS_PER_YEAR / hoursElapsed) : 0;
  const gapSkippedSec = (position.accruals || []).reduce((s, a) => s + (a.gapSkippedSec || 0), 0);
  return {
    grossPnl,
    netPnl,
    roundTripCost: position.roundTripCost,
    equityGross: position.capital + grossPnl,
    equityNet: position.capital + netPnl,
    ret,
    apr,
    aprGross,
    aprReliable: hoursElapsed >= APR_MIN_HOURS,
    hoursElapsed,
    gapSkippedSec, // seconds of history that could NOT be priced (no data) — honesty marker
    maxDrawdown: position.maxDrawdown, // $, <= 0
    // drawdown as a fraction of NOTIONAL (the base the excursion actually scales with); the UI
    // multiplies by leverage when a capital-relative % is wanted. (audit: was /capital, leverage-inflated)
    maxDrawdownPct: position.notional ? Math.abs(position.maxDrawdown) / position.notional : 0,
  };
}

// Portfolio max drawdown ($, <= 0) on the COMBINED equity curve across positions — NOT the sum of
// per-position drawdowns (troughs at different times must not be added; maxDD is not additive).
// Each position contributes its running cumulative funding (cum); pointers advance independently by
// time, so a position that has not opened yet contributes 0 and a closed one holds its final cum.
export function combinedMaxDrawdown(positions) {
  const active = (positions || []).filter((p) => p.equityCurve && p.equityCurve.length);
  if (!active.length) return 0;
  const ptr = active.map(() => 0);
  const cum = active.map(() => 0);
  const times = [...new Set(active.flatMap((p) => p.equityCurve.map((pt) => pt.t)))].sort((a, b) => a - b);
  let peak = 0;
  let worst = 0;
  for (const t of times) {
    let total = 0;
    for (let i = 0; i < active.length; i++) {
      const ec = active[i].equityCurve;
      while (ptr[i] < ec.length && ec[ptr[i]].t <= t) cum[i] = ec[ptr[i]++].cum;
      total += cum[i];
    }
    if (total > peak) peak = total;
    const dd = total - peak;
    if (dd < worst) worst = dd;
  }
  return worst;
}

// Account roll-up across all paper positions (open + closed). Annualizes over the ACTUAL accrual
// horizon (first createdAt -> last accrual across positions), NOT wall-clock now — so realized APR
// and $/hr stay frozen after positions close instead of decaying to zero. Drawdown is the
// combined-curve drawdown; notionalAll exposes leveraged per-leg notional for the UI. Returns null
// for an empty account.
export function accountSummary(positions) {
  const ps = positions || [];
  if (!ps.length) return null;
  let netPnl = 0;
  let grossPnl = 0;
  let capitalAll = 0;
  let notionalAll = 0;
  let gapSkippedSec = 0;
  let firstT0 = Infinity;
  let lastT = 0;
  let open = 0;
  for (const p of ps) {
    const s = positionSummary(p);
    netPnl += s.netPnl;
    grossPnl += s.grossPnl;
    capitalAll += p.capital;
    notionalAll += p.notional;
    gapSkippedSec += s.gapSkippedSec;
    firstT0 = Math.min(firstT0, p.createdAt);
    lastT = Math.max(lastT, p.lastAccrualAt || p.createdAt);
    if (p.status === "open") open++;
  }
  const hoursSinceFirst = (Math.max(lastT, firstT0) - firstT0) / HOUR_MS;
  const ret = capitalAll ? netPnl / capitalAll : 0;
  const apr = capitalAll && hoursSinceFirst > 0 ? ret * (HOURS_PER_YEAR / hoursSinceFirst) : 0;
  const aprGross = capitalAll && hoursSinceFirst > 0 ? (grossPnl / capitalAll) * (HOURS_PER_YEAR / hoursSinceFirst) : 0;
  return {
    count: ps.length,
    open,
    closed: ps.length - open,
    netPnl,
    grossPnl,
    capitalAll,
    notionalAll,
    ret,
    apr,
    aprGross,
    aprReliable: hoursSinceFirst >= APR_MIN_HOURS,
    hoursSinceFirst,
    firstT0,
    maxDrawdown: combinedMaxDrawdown(ps),
    gapSkippedSec,
  };
}
