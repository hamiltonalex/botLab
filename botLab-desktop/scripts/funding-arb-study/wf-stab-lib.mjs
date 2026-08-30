import { APP as STUDY_APP } from "./paths.mjs";
// Shared loader for the stability measurement. Engine functions only, no re-implemented accrual math.
import { readFileSync } from "node:fs";
import { parseSpreadCsv } from "../../src/engine/format.js";

export const FIXDIR = STUDY_APP+"/test/fixtures";
export const TOKENS = ["APT", "BTC", "ETH"];

export function loadRows(token) {
  return parseSpreadCsv(readFileSync(`${FIXDIR}/${token}.csv`, "utf8"));
}

export function loadAll() {
  const out = {};
  for (const t of TOKENS) out[t] = loadRows(t);
  return out;
}

export const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
export const f4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : "n/a");
export const pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1) + "%" : "n/a");
