import { APP as STUDY_APP, CACHE as STUDY_CACHE } from "./paths.mjs";
import fs from "node:fs";
import path from "node:path";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { scanTwoLeg, scanOneLeg } from "../../src/engine/math.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";
import { openPosition, accrueFromRows, closePosition, positionSummary, accountSummary } from "../../src/engine/paper.js";

export const CACHE = STUDY_CACHE;
export const FIX = STUDY_APP+"/test/fixtures";
export { scanTwoLeg, scanOneLeg, DEFAULT_COSTS, roundTripCost, openPosition, accrueFromRows, closePosition, positionSummary, accountSummary, parseSpreadCsv };

export function loadAll() {
  const files = fs.readdirSync(CACHE).filter((f) => f.endsWith(".csv") && !f.startsWith("_"));
  const out = new Map();
  for (const f of files) {
    const tok = f.replace(/_\d+_\d+\.csv$/, "");
    const rows = parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8"));
    out.set(tok, rows);
  }
  return out;
}

// Run ONE two-leg paper position over `rows` with `config`, capital, 1x. Returns positionSummary.
export function runPos({ rows, token, config, capital, strategy = "two", payCost = true }) {
  const notional = capital;
  const rt = payCost ? roundTripCost(DEFAULT_COSTS, notional, strategy === "one") : 0;
  const t0 = rows[0].tsHour * 1000;
  const end = rows[rows.length - 1].tsHour * 1000 + 3600 * 1000;
  const p = openPosition({ strategy, instrumentKey: token, config, capital, leverage: 1, nowMs: t0, roundTripCost: rt });
  const a = accrueFromRows(p, rows, end);
  closePosition(p, end);
  return { p, s: positionSummary(p), applied: a };
}
