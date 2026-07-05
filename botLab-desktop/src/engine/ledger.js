// ledger.js — the per-position transaction ledger (Журнал операций), DERIVED on demand from the
// position's persisted accruals[] + one-off round-trip cost. Nothing here is stored separately:
// a parallel persisted ledger array could drift from the accrual state (the state-drift bug class
// this project's audits keep hunting), while a pure derivation cannot — by construction.
//
// Reconciliation identity (test + oracle + UI badge): for any position,
//   lastEvent.runningBalance === sum(income) - sum(expense) === positionSummary(position).netPnl
// The ledger conforms to positionSummary(), never the reverse.

import { legModel, positionSummary } from "./paper.js";

export const LEDGER_TYPES = ["open_costs", "gmx_funding", "gmx_borrow", "hl_funding", "gap_unpriced", "manual_adjustment"];

// One economic operation. amount is the SIGNED $ delta to net P&L (income > 0, expense < 0);
// income/expense are the pre-split accounting columns; seq is the primary ordering key (t can
// collide: a funding row and an HL settlement may share the same boundary timestamp).
function mkEvent(position, seq, t, type, amount, extra) {
  const category = amount > 0 ? "income" : amount < 0 ? "expense" : "neutral";
  return {
    id: `${position.id}_${seq}`,
    seq,
    t,
    type,
    category,
    amount,
    income: amount > 0 ? amount : 0,
    expense: amount < 0 ? -amount : 0,
    runningBalance: 0, // filled by buildLedger
    instrumentKey: position.instrumentKey,
    positionSize: position.notional,
    leverage: position.leverage,
    currency: "USD",
    venue: null,
    direction: null,
    strategyLeg: null,
    fundingIntervalSec: null,
    priceAtOp: null,
    source: null,
    description: "",
    breakdown: null,
    meta: {},
    ...extra,
  };
}

// Build the full event list for a position, oldest first, seq-monotonic. Pure function of data
// already persisted on the position; positions opened before the ledger feature lack the
// fundingUsd/borrowUsd split on old accrual entries — those render as ONE honest "агрегировано"
// funding row (never a fabricated split) via meta.aggregated.
export function buildLedger(position) {
  const events = [];
  let seq = 0;
  let bal = 0;
  const push = (t, type, amount, extra) => {
    const e = mkEvent(position, seq++, t, type, amount, extra);
    bal += amount;
    e.runningBalance = bal;
    events.push(e);
    return e;
  };

  const { gmxSide, hlPerHourSign } = legModel(position.strategy, position.config);
  const hlDirection = hlPerHourSign === -1 ? "long" : hlPerHourSign === 1 ? "short" : null;
  const oneLeg = position.strategy === "one";

  // seq 0 — the round-trip costs, charged once at t0 (the engine's honest Phase-1 model prices
  // open+close as one prepaid scalar; splitting a fabricated "close fee at close time" would
  // invent precision the engine does not have).
  push(position.createdAt, "open_costs", -(position.roundTripCost || 0), {
    strategyLeg: oneLeg ? "gmx" : "both",
    priceAtOp: Number.isFinite(position.openMarkPx) ? position.openMarkPx : null,
    source: "open",
    description: "разовые издержки входа-выхода · зафиксированы при открытии",
    breakdown: position.costBreakdown || null,
  });

  for (const a of position.accruals || []) {
    if (a.source === "skipped") {
      push(a.t, "gap_unpriced", 0, {
        source: "skipped",
        description: "разрыв данных — интервал не начислен",
        meta: { gapSkippedSec: a.gapSkippedSec || 0, reason: a.reason || null },
      });
      continue;
    }
    // A live/history step may ALSO carry an uncovered remainder (cap trimming / hole before a
    // valid hour). Surface it as its own $0 marker so the ledger explains every second of time.
    if ((a.gapSkippedSec || 0) > 0) {
      push(a.t, "gap_unpriced", 0, {
        source: a.source,
        description: "разрыв данных — часть интервала не начислена",
        meta: { gapSkippedSec: a.gapSkippedSec, reason: "нет пригодных данных для оценки этого отрезка" },
      });
    }

    const aggregated = !Number.isFinite(a.fundingUsd);
    const fundingAmt = aggregated ? a.dPnlGmx || 0 : a.fundingUsd;
    const borrowAmt = aggregated ? 0 : Number.isFinite(a.borrowUsd) ? a.borrowUsd : a.dPnlGmx - a.fundingUsd;
    const px = Number.isFinite(a.markPx) ? a.markPx : null;

    push(a.t, "gmx_funding", fundingAmt, {
      venue: "GMX",
      direction: gmxSide,
      strategyLeg: "gmx",
      fundingIntervalSec: a.dtSec || null,
      priceAtOp: px,
      source: a.source,
      description:
        "финансирование GMX · " +
        (gmxSide === "short" ? "короткая нога" : "длинная нога") +
        (aggregated ? " · агрегировано (funding+borrow не разделены в этой записи)" : ""),
      meta: aggregated ? { aggregated: true } : {},
    });
    if (borrowAmt !== 0) {
      push(a.t, "gmx_borrow", borrowAmt, {
        venue: "GMX",
        direction: gmxSide,
        strategyLeg: "gmx",
        fundingIntervalSec: a.dtSec || null,
        priceAtOp: px,
        source: a.source,
        description: "заимствование GMX · издержка " + (gmxSide === "short" ? "короткой" : "длинной") + " ноги",
      });
    }
    if ((a.hlSettlements || 0) > 0) {
      push(a.t, "hl_funding", a.dPnlHl, {
        venue: "Hyperliquid",
        direction: hlDirection,
        strategyLeg: "hl",
        fundingIntervalSec: 3600,
        priceAtOp: px,
        source: a.source,
        description:
          "расчёт финансирования Hyperliquid · " +
          (hlDirection === "long" ? "длинная нога" : "короткая нога") +
          (a.hlSettlements > 1 ? " · ×" + a.hlSettlements + " часовых расчётов" : ""),
        meta: { settlements: a.hlSettlements },
      });
    }
  }
  return events;
}

export function ledgerTotals(events) {
  let income = 0;
  let expense = 0;
  for (const e of events || []) {
    income += e.income;
    expense += e.expense;
  }
  return { income, expense, net: income - expense, count: (events || []).length };
}

// The reconciliation identity, usable by tests, the oracle and the fa:getLedger handler alike.
export function ledgerReconciles(position, events, tol = 1e-6) {
  const s = positionSummary(position);
  const last = events && events.length ? events[events.length - 1].runningBalance : 0;
  const { income, expense, net } = ledgerTotals(events);
  const scale = Math.max(1, Math.abs(s.netPnl));
  const okBalance = Math.abs(last - s.netPnl) <= tol * scale;
  const okSum = Math.abs(net - s.netPnl) <= tol * scale;
  return {
    ok: okBalance && okSum,
    delta: net - s.netPnl,
    lastRunningBalance: last,
    netFromEvents: net,
    positionNetPnl: s.netPnl,
    sumIncome: income,
    sumExpense: expense,
  };
}

// UTC day key for the renderer's day separators, e.g. "2026-07-03".
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

// Windowed query over the derived ledger — the single implementation behind BOTH the
// fa:getLedger IPC handler and the oracle's renderer stub, so what the UI shows is provably
// what the engine derives. Totals/recon are ALWAYS over the FULL unfiltered ledger (accounting
// transparency: the headline numbers must reconcile with the position no matter the filter);
// the filtered subtotal is reported separately.
export function ledgerView(position, opts = {}) {
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limitRaw = Number(opts.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : 200;
  const order = opts.order === "asc" ? "asc" : "desc";
  const types = Array.isArray(opts.types) && opts.types.length ? opts.types.filter((t) => LEDGER_TYPES.includes(t)) : null;

  const all = buildLedger(position);
  const counts = {};
  for (const t of LEDGER_TYPES) counts[t] = 0;
  for (const e of all) counts[e.type]++;
  const totalsAll = ledgerTotals(all);
  const recon = ledgerReconciles(position, all);

  const filtered = types ? all.filter((e) => types.includes(e.type)) : all;
  const filteredTotals = types ? ledgerTotals(filtered) : null;

  const dayNets = {};
  for (const e of filtered) {
    const k = dayKey(e.t);
    dayNets[k] = (dayNets[k] || 0) + e.amount;
  }

  const ordered = order === "desc" ? [...filtered].reverse() : filtered;
  const page = ordered.slice(offset, offset + limit);

  return {
    positionId: position.id,
    events: page,
    totalCount: filtered.length,
    allCount: all.length,
    counts,
    totalsAll,
    filteredTotals,
    recon: { ok: recon.ok, delta: recon.delta, positionNetPnl: recon.positionNetPnl, netFromEvents: recon.netFromEvents },
    dayNets,
    order,
    offset,
    limit,
  };
}
