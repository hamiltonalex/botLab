import { APP as STUDY_APP } from "./paths.mjs";
// Shared loader: real engine only, no hand arithmetic.
import { readFileSync } from "node:fs";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { scanTwoLeg, scanOneLeg, annualizeRow, maxDrawdownFraction, pnlPath, HOURS_PER_YEAR } from "../../src/engine/math.js";
import { DEFAULT_COSTS, roundTripCost, roundTripCostBreakdown, normalizeCosts } from "../../src/engine/costs.js";
import { openPosition, accrueFromRows, closePosition, positionSummary, accountSummary } from "../../src/engine/paper.js";

const FIX = STUDY_APP+"/test/fixtures";
export const ASSETS = ["APT", "BTC", "ETH"];
export const POSITIONS = [];
for (const a of ASSETS) {
  POSITIONS.push({ key: a, asset: a, strategy: "two", config: "A", label: `${a} two-A` });
  POSITIONS.push({ key: a, asset: a, strategy: "two", config: "B", label: `${a} two-B` });
  POSITIONS.push({ key: a, asset: a, strategy: "one", config: null, label: `${a} one` });
}

export function loadRows(asset) {
  return parseSpreadCsv(readFileSync(`${FIX}/${asset}.csv`, "utf8"));
}

// Gross $ over the whole fixture via the REAL paper ledger (openPosition/accrueFromRows).
export function runPaper(rows, spec, capital, leverage) {
  const t0 = rows[0].tsHour * 1000;
  const end = (rows[rows.length - 1].tsHour + 3600) * 1000;
  const notional = capital * leverage;
  const isOne = spec.strategy === "one";
  const p = openPosition({
    strategy: spec.strategy,
    instrumentKey: spec.key,
    config: spec.config,
    capital,
    leverage,
    nowMs: t0,
    roundTripCost: roundTripCost(DEFAULT_COSTS, notional, isOne),
    costBreakdown: roundTripCostBreakdown(DEFAULT_COSTS, notional, isOne),
  });
  const applied = accrueFromRows(p, rows, end);
  closePosition(p, end);
  return { pos: p, applied, summary: positionSummary(p) };
}

export { parseSpreadCsv, scanTwoLeg, scanOneLeg, annualizeRow, maxDrawdownFraction, pnlPath, HOURS_PER_YEAR, DEFAULT_COSTS, roundTripCost, roundTripCostBreakdown, normalizeCosts, openPosition, accrueFromRows, closePosition, positionSummary, accountSummary };
