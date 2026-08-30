import { APP as STUDY_APP } from "./paths.mjs";
import { readFileSync } from "node:fs";
const B = STUDY_APP;
const { DEFAULT_COSTS, COST_LIMITS, normalizeCosts, roundTripCost, roundTripCostBreakdown } = await import(B + "/src/engine/costs.js");
const { parseSpreadCsv } = await import(B + "/src/engine/format.js");
const { scanTwoLeg, scanOneLeg, annualizeRow, maxDrawdownFraction, pnlPath, HOURS_PER_YEAR } = await import(B + "/src/engine/math.js");
const { openPosition, accrueFromRows, closePosition, positionSummary, accountSummary } = await import(B + "/src/engine/paper.js");

const f = (x, d = 6) => Number(x).toFixed(d);

console.log("== 1. DEFAULT_COSTS ==");
console.log(JSON.stringify(DEFAULT_COSTS));
console.log("COST_LIMITS:", JSON.stringify(COST_LIMITS));

console.log("\n== 2. round-trip cost as % of notional (via roundTripCost, gas isolated) ==");
// pct part = (roundTripCost(N) - roundTripCost(0)) / N ; gas = roundTripCost(0)
const gas = roundTripCost(DEFAULT_COSTS, 0, false);
for (const isOne of [false, true]) {
  const label = isOne ? "one-leg " : "two-leg ";
  for (const N of [2000, 20000, 1e6]) {
    const c = roundTripCost(DEFAULT_COSTS, N, isOne);
    console.log(`${label} N=$${N.toLocaleString()}  cost=$${c.toFixed(4)}  = ${(100*c/N).toFixed(5)}% of notional   (pct-only ${(100*(c-gas)/N).toFixed(5)}%, flat $${gas})`);
  }
  const bd = roundTripCostBreakdown(DEFAULT_COSTS, 2000, isOne);
  const sum = Object.values(bd).reduce((a,b)=>a+b,0);
  console.log(`${label} breakdown@2000:`, JSON.stringify(bd), " sum=", sum.toFixed(10), " identity ok:", sum === roundTripCost(DEFAULT_COSTS, 2000, isOne));
}

console.log("\n== 3. normalizeCosts guard behaviour (clamp, not reject) ==");
console.log("neg fees ->", JSON.stringify(normalizeCosts({ gmxOpen: -5, hlTaker: -1, gmxGas: -99 })));
console.log("absurd   ->", JSON.stringify(normalizeCosts({ gmxOpen: 1e9, hlSides: 2.7, gmxGas: 1e12 })));
console.log("NaN/junk ->", JSON.stringify(normalizeCosts({ gmxOpen: "abc", hlTaker: null, gmxGas: Infinity })));

console.log("\n== 4. break-even holding period, LINEAR carry model (cost via roundTripCost) ==");
// gross(t) = apr * notional * t_years ; solve gross(t) == roundTripCost
function beDays(apr, capital, lev, isOne) {
  const N = capital * lev;
  const c = roundTripCost(DEFAULT_COSTS, N, isOne);
  const perYear = apr * N;
  return { costUsd: c, perYear, days: (c / perYear) * 365, hours: (c / perYear) * HOURS_PER_YEAR };
}
for (const [name, apr] of [["carry 2.6%/yr (BTC/ETH class)", 0.026], ["carry 53%/yr (APT class)", 0.53]]) {
  console.log(`-- ${name}`);
  for (const [lbl, cap, lev, isOne] of [
    ["two-leg $2000 1x", 2000, 1, false],
    ["one-leg $2000 1x", 2000, 1, true],
    ["two-leg $2000 10x", 2000, 10, false],
    ["two-leg $1,000,000 1x", 1e6, 1, false],
  ]) {
    const r = beDays(apr, cap, lev, isOne);
    console.log(`   ${lbl.padEnd(22)} cost=$${r.costUsd.toFixed(2)}  carry=$${r.perYear.toFixed(2)}/yr  break-even = ${r.days.toFixed(2)} d (${r.hours.toFixed(1)} h)`);
  }
}

console.log("\n== 5. break-even on the REAL hourly path (pnlPath vs roundTripCost) ==");
const fx = {};
for (const k of ["APT", "BTC", "ETH"]) fx[k] = parseSpreadCsv(readFileSync(`${B}/test/fixtures/${k}.csv`, "utf8"));
const N = 2000;
const rows = [];
for (const k of ["APT", "BTC", "ETH"]) {
  const two = scanTwoLeg(fx[k], { token: k });
  const one = scanOneLeg(fx[k], { token: k });
  for (const [tag, series, isOne] of [
    [`${k} two-${two.chosen}(chosen)`, two.net, false],
    [`${k} two-A`, two.seriesA, false],
    [`${k} two-B`, two.seriesB, false],
    [`${k} one`, one.net, true],
  ]) {
    const p = pnlPath(series, N);
    const cost = roundTripCost(DEFAULT_COSTS, N, isOne);
    // first hour where cumulative gross covers the round trip, and whether it STAYS covered
    let firstH = -1, lastBelow = -1;
    for (let i = 0; i < p.cum.length; i++) {
      if (p.cum[i] >= cost) { if (firstH < 0) firstH = i + 1; }
      else lastBelow = i + 1;
    }
    const meanApr = series.reduce((a,b)=>a+b,0)/series.length;
    rows.push({ tag, isOne, meanApr, gross: p.total, cost, net: p.total - cost, firstH, lastBelow, hours: p.cum.length });
  }
}
for (const r of rows) {
  console.log(`${r.tag.padEnd(20)} meanAPR=${(100*r.meanApr).toFixed(2).padStart(8)}%  gross=$${r.gross.toFixed(2).padStart(9)}  cost=$${r.cost.toFixed(2)}  net=$${r.net.toFixed(2).padStart(9)}  first-hour-above-cost=${r.firstH<0?"NEVER":r.firstH}  last-hour-below-cost=${r.lastBelow<0?"never dips":r.lastBelow}/${r.hours}`);
}

console.log("\n== 6. same break-even measured through the PAPER ledger (openPosition/accrueFromRows) ==");
for (const [k, strat, cfg] of [["BTC","two","B"],["ETH","two","A"],["APT","two","A"],["BTC","one",null],["ETH","one",null],["APT","one",null]]) {
  const rws = fx[k];
  const t0 = rws[0].tsHour * 1000;
  const tEnd = rws[rws.length-1].tsHour*1000 + 3600*1000;
  const isOne = strat === "one";
  const cost = roundTripCost(DEFAULT_COSTS, N, isOne);
  const pos = openPosition({ strategy: strat, instrumentKey: k, config: cfg, capital: N, leverage: 1, nowMs: t0, roundTripCost: cost });
  accrueFromRows(pos, rws, tEnd);
  closePosition(pos, tEnd);
  const s = positionSummary(pos);
  // first accrual point where cum funding covers the round-trip cost
  let firstIdx = -1;
  for (let i=0;i<pos.equityCurve.length;i++) if (pos.equityCurve[i].cum >= cost) { firstIdx = i; break; }
  const firstH = firstIdx < 0 ? null : (pos.equityCurve[firstIdx].t - t0)/3600e3;
  console.log(`${k} ${strat}${cfg||""}: gross=$${s.grossPnl.toFixed(2)} cost=$${cost.toFixed(2)} net=$${s.netPnl.toFixed(2)} hours=${s.hoursElapsed} gapSkippedSec=${s.gapSkippedSec} | first hour cum>=cost: ${firstH===null?"NEVER in 365d":firstH+" h ("+(firstH/24).toFixed(2)+" d)"}`);
}
