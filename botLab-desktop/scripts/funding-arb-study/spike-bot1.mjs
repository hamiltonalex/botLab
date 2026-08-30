import { APP as STUDY_APP } from "./paths.mjs";
import { readFileSync } from "node:fs";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { scanTwoLeg, scanOneLeg } from "../../src/engine/math.js";
import { openPosition, accrueFromRows, closePosition, positionSummary, accountSummary } from "../../src/engine/paper.js";
import { roundTripCost, DEFAULT_COSTS } from "../../src/engine/costs.js";

const BASE = STUDY_APP+"/test/fixtures/";
const positions = [];
for (const token of ["APT", "BTC", "ETH"]) {
  const rows = parseSpreadCsv(readFileSync(BASE + token + ".csv", "utf8"));
  const t0 = rows[0].tsHour * 1000, tN = rows.at(-1).tsHour * 1000 + 3600000;
  const two = scanTwoLeg(rows, { token });
  const one = scanOneLeg(rows, { token });
  const notional = 2000;
  for (const [strategy, config] of [["two", two.chosen], ["one", null]]) {
    const p = openPosition({ strategy, instrumentKey: token, config, capital: notional, leverage: 1,
      nowMs: t0, roundTripCost: roundTripCost(DEFAULT_COSTS, notional, strategy === "one") });
    const r = accrueFromRows(p, rows, tN);
    closePosition(p, tN);
    const s = positionSummary(p);
    positions.push(p);
    console.log(`${token} ${strategy}${config ? " " + config : ""}: часов ${r.hoursApplied}, пропущено ${r.gapSkippedSec}s, ` +
      `шагов ${p.accruals.length}, cum $${p.cumFunding.toFixed(4)}, net $${s.netPnl.toFixed(4)}, dd $${p.maxDrawdown.toFixed(2)}`);
  }
  console.log(`   период ${rows[0].ts} .. ${rows.at(-1).ts}; строк ${rows.length}; scanTwoLeg=${two.chosen} netMean=${(two[two.chosen].netMean*100).toFixed(2)}% oneLeg=${(one.netMean*100).toFixed(2)}%`);
}
const acc = accountSummary(positions);
console.log("account:", JSON.stringify(acc));
