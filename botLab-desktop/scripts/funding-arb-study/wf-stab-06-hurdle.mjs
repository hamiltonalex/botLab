// 1c. A rolling window is only tradable if it clears the round-trip cost. pnlPath (engine) turns
//     each window's net-APR series into $ on $2000, compared against roundTripCost(DEFAULT_COSTS).
import { scanTwoLeg, scanOneLeg, pnlPath, maxDrawdownFraction } from "../../src/engine/math.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";
import { loadAll, TOKENS, f2, pc } from "./wf-stab-lib.mjs";

const CAP = 2000;
const rtTwo = roundTripCost(DEFAULT_COSTS, CAP, false);
const rtOne = roundTripCost(DEFAULT_COSTS, CAP, true);
console.log(`round trip on $${CAP}: two-leg $${f2(rtTwo)}, one-leg $${f2(rtOne)}`);
const data = loadAll();
const STEP = 6;

for (const hours of [720, 2160]) {
  console.log(`\n=== rolling ${hours / 24}d windows, step ${STEP}h - gross $ on $2000, and share clearing the round trip ===`);
  console.log(["series", "nWin", "%win gross>0", "%win NET>0 (clears cost)", "median gross$", "p05", "p95", "worst$", "best$"].join("\t"));
  for (const token of TOKENS) {
    const rows = data[token];
    const acc = { "two-A": [], "two-B": [], one: [] };
    for (let i = 0; i + hours <= rows.length; i += STEP) {
      const s = rows.slice(i, i + hours);
      const t = scanTwoLeg(s, { token });
      acc["two-A"].push(pnlPath(t.A._net, CAP).total);
      acc["two-B"].push(pnlPath(t.B._net, CAP).total);
      acc.one.push(pnlPath(scanOneLeg(s, { token }).net, CAP).total);
    }
    for (const [cfg, arr] of Object.entries(acc)) {
      const rt = cfg === "one" ? rtOne : rtTwo;
      const so = arr.slice().sort((a, b) => a - b);
      const q = (p) => so[Math.min(so.length - 1, Math.round((so.length - 1) * p))];
      console.log([`${token} ${cfg}`, arr.length, pc(arr.filter((x) => x > 0).length / arr.length), pc(arr.filter((x) => x > rt).length / arr.length), f2(q(0.5)), f2(q(0.05)), f2(q(0.95)), f2(so[0]), f2(so[so.length - 1])].join("\t"));
    }
  }
}
