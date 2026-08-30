import { APP as STUDY_APP } from "./paths.mjs";
import { readFileSync } from "node:fs";
const B = STUDY_APP;
const { DEFAULT_COSTS, roundTripCost, roundTripCostBreakdown } = await import(B + "/src/engine/costs.js");
const { parseSpreadCsv } = await import(B + "/src/engine/format.js");
const { scanTwoLeg, scanOneLeg, pnlPath, maxDrawdownFraction, HOURS_PER_YEAR } = await import(B + "/src/engine/math.js");

console.log("== breakdown identity, exact float ==");
for (const N of [2000, 20000, 1e6, 1234.56]) {
  for (const isOne of [false, true]) {
    const c = roundTripCost(DEFAULT_COSTS, N, isOne);
    const bd = roundTripCostBreakdown(DEFAULT_COSTS, N, isOne);
    const s = Object.values(bd).reduce((a,b)=>a+b,0);
    console.log(`N=${N} one=${isOne}  total=${c}  sum=${s}  diff=${(s-c).toExponential(3)}  strictEq=${s===c}`);
  }
}

console.log("\n== how many round trips a year of carry pays for (cost via roundTripCost) ==");
for (const [nm, apr] of [["2.6%", 0.026], ["53%", 0.53]]) {
  for (const [lbl, N, isOne] of [["two-leg", 2000, false], ["one-leg", 2000, true], ["two-leg $1M", 1e6, false]]) {
    const c = roundTripCost(DEFAULT_COSTS, N, isOne);
    console.log(`carry ${nm} ${lbl.padEnd(12)} annual carry $${(apr*N).toFixed(2)} / round trip $${c.toFixed(2)} = ${(apr*N/c).toFixed(2)} round trips per year before carry is fully eaten`);
  }
}

console.log("\n== cost as share of the measured 365d gross ==");
const fx = {};
for (const k of ["APT","BTC","ETH"]) fx[k] = parseSpreadCsv(readFileSync(`${B}/test/fixtures/${k}.csv`,"utf8"));
const N = 2000;
for (const k of ["APT","BTC","ETH"]) {
  const two = scanTwoLeg(fx[k], { token: k }), one = scanOneLeg(fx[k], { token: k });
  for (const [tag, ser, isOne] of [[`${k} two-${two.chosen}`, two.net, false], [`${k} one`, one.net, true]]) {
    const p = pnlPath(ser, N), c = roundTripCost(DEFAULT_COSTS, N, isOne);
    // crossings of the cost line
    let cross = 0, above = p.cum[0] >= c;
    for (const v of p.cum) { const a = v >= c; if (a !== above) { cross++; above = a; } }
    const dd = maxDrawdownFraction(ser) * N;
    console.log(`${tag.padEnd(10)} gross=$${p.total.toFixed(2).padStart(9)}  rtCost=$${c.toFixed(2)}  cost/gross=${p.total>0?(100*c/p.total).toFixed(2)+"%":"n/a (gross<=0)"}  cost-line crossings=${cross}  maxDD(gross,$)=${dd.toFixed(2)}  cost/maxDD=${(c/dd).toFixed(3)}`);
  }
}

console.log("\n== gas symmetry check: is gmxGas charged once or twice per round trip? ==");
const b = roundTripCostBreakdown({...DEFAULT_COSTS, gmxGas: 7}, 1000, false);
console.log("gmxGas=7 -> breakdown.gmxGasUsd =", b.gmxGasUsd, "(open+close together)");
console.log("hlTakerUsd with hlSides=2 =", b.hlTakerUsd, "= 2 x", 1000*DEFAULT_COSTS.hlTaker/100, "(both sides)");
