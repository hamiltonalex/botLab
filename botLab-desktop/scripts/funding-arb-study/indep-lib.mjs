import { APP as STUDY_APP, CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs"; import path from "node:path";
const ENG = STUDY_APP+"/src/engine";
export const { parseSpreadCsv } = await import(`${ENG}/format.js`);
export const { scanTwoLeg, annualizeRow, mean, median } = await import(`${ENG}/math.js`);
export const { DEFAULT_COSTS, roundTripCost } = await import(`${ENG}/costs.js`);
export const { openPosition, accrueFromRows, closePosition, positionSummary, legModel } = await import(`${ENG}/paper.js`);

export const CACHE = STUDY_CACHE;
export const SP = STUDY_DATA;
export const YEAR = 8761;

// tokens that have BOTH a full-year csv and an OI file
export const OI_DIR = `${SP}/truth-a-oi2`;
export const oiTokens = fs.readdirSync(OI_DIR).filter(f=>f.endsWith(".json")).map(f=>f.replace(".json",""));

export function loadRows(tok) {
  const f = fs.readdirSync(CACHE).find(f => f.startsWith(tok + "_") && f.endsWith(".csv"));
  if (!f) return null;
  return parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8"));
}
export function loadOi(tok) {
  const j = JSON.parse(fs.readFileSync(`${OI_DIR}/${tok}.json`, "utf8"));
  const m = new Map();
  for (const s of j.oi) m.set(Number(s.snapshotTimestamp), {
    bl: Number(s.longFundingBalanceOiUsd) / 1e30,
    bs: Number(s.shortFundingBalanceOiUsd) / 1e30,
    tl: Number(s.longOpenInterestInTokens),
    ts_: Number(s.shortOpenInterestInTokens),
    tokMode: !!s.useOpenInterestInTokensForBalance,
  });
  return m;
}
export const fmt$ = (x) => (x<0?"-":"")+"$"+Math.abs(x).toLocaleString("en-US",{maximumFractionDigits:0});
