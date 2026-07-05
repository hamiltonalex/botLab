// export.js — ledger export serializers (pure, unit-testable without Electron). The export is
// ALWAYS the FULL ledger of one position with every audit field, independent of the on-screen
// filter/pagination: the file must stand alone for reconciliation, audit or re-import.

import { positionSummary } from "../engine/paper.js";
import { ledgerTotals, ledgerReconciles } from "../engine/ledger.js";

// Flat column pool (superset of the on-screen table) — order is the audit-friendly reading order.
export const LEDGER_COLUMNS = [
  ["seq", (e) => e.seq],
  ["operation_id", (e) => e.id],
  ["time_utc", (e) => new Date(e.t).toISOString()],
  ["type", (e) => e.type],
  ["category", (e) => e.category],
  ["description", (e) => e.description],
  ["venue", (e) => e.venue ?? ""],
  ["instrument", (e) => e.instrumentKey],
  ["direction", (e) => e.direction ?? ""],
  ["strategy_leg", (e) => e.strategyLeg ?? ""],
  ["income_usd", (e) => e.income],
  ["expense_usd", (e) => e.expense],
  ["amount_usd", (e) => e.amount],
  ["running_balance_usd", (e) => e.runningBalance],
  ["funding_interval_sec", (e) => e.fundingIntervalSec ?? ""],
  ["price_at_op", (e) => e.priceAtOp ?? ""],
  ["position_size_usd", (e) => e.positionSize],
  ["leverage", (e) => e.leverage],
  ["currency", (e) => e.currency],
  ["source", (e) => e.source ?? ""],
  ["aggregated", (e) => (e.meta && e.meta.aggregated ? 1 : "")],
  ["hl_settlements", (e) => e.meta?.settlements ?? ""],
  ["gap_skipped_sec", (e) => e.meta?.gapSkippedSec ?? ""],
  ["reason", (e) => e.meta?.reason ?? ""],
  ["breakdown_gmx_open_usd", (e) => e.breakdown?.gmxOpenUsd ?? ""],
  ["breakdown_gmx_close_usd", (e) => e.breakdown?.gmxCloseUsd ?? ""],
  ["breakdown_gmx_impact_usd", (e) => e.breakdown?.gmxImpactUsd ?? ""],
  ["breakdown_gmx_gas_usd", (e) => e.breakdown?.gmxGasUsd ?? ""],
  ["breakdown_hl_taker_usd", (e) => e.breakdown?.hlTakerUsd ?? ""],
];

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// UTF-8 BOM + CRLF: the combination Excel-on-Windows needs to open a UTF-8 CSV with no wizard.
export function toLedgerCsv(events) {
  const head = LEDGER_COLUMNS.map(([name]) => name).join(",");
  const lines = events.map((e) => LEDGER_COLUMNS.map(([, get]) => csvCell(get(e))).join(","));
  return "﻿" + [head, ...lines].join("\r\n") + "\r\n";
}

// XLSX sheet rows: numbers stay numbers, everything else becomes a display string.
export function toLedgerSheet(events) {
  const header = LEDGER_COLUMNS.map(([name]) => name);
  const rows = events.map((e) =>
    LEDGER_COLUMNS.map(([, get]) => {
      const v = get(e);
      return typeof v === "number" && Number.isFinite(v) ? v : v === "" || v === null || v === undefined ? null : String(v);
    }),
  );
  return { header, rows };
}

// Self-contained JSON: position passport + summary + totals + reconciliation verdict + events.
export function toLedgerJson(position, events) {
  return JSON.stringify(
    {
      format: "funding-arb-ledger",
      version: 1,
      exportedAt: new Date().toISOString(),
      position: {
        id: position.id,
        instrumentKey: position.instrumentKey,
        strategy: position.strategy,
        config: position.config,
        capital: position.capital,
        leverage: position.leverage,
        notional: position.notional,
        createdAt: position.createdAt,
        closedAt: position.closedAt,
        status: position.status,
        roundTripCost: position.roundTripCost,
        costBreakdown: position.costBreakdown ?? null,
        openMarkPx: position.openMarkPx ?? null,
        meta: position.meta ?? {},
      },
      summary: positionSummary(position),
      totals: ledgerTotals(events),
      reconciliation: ledgerReconciles(position, events),
      events,
    },
    null,
    2,
  );
}

// fa-ledger_ETH_p3-1751234567890_20260704-1530.csv — sortable, position-traceable.
export function ledgerFileName(position, format, now = new Date()) {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const safeKey = String(position.instrumentKey || "pos").replace(/[^A-Za-z0-9_-]+/g, "-");
  const safeId = String(position.id || "").replace(/[^A-Za-z0-9_-]+/g, "-");
  return `fa-ledger_${safeKey}_${safeId}_${stamp}.${format}`;
}

export function dialogFiltersFor(format) {
  if (format === "csv") return [{ name: "CSV", extensions: ["csv"] }];
  if (format === "xlsx") return [{ name: "Excel", extensions: ["xlsx"] }];
  return [{ name: "JSON", extensions: ["json"] }];
}
