import { POSITIONS, loadRows, runPaper, DEFAULT_COSTS, roundTripCost, roundTripCostBreakdown } from "./wf-cost-lib.mjs";

const CAP = 2000, LEV = 1, N = CAP * LEV;
// Cost multiplier scales the PRICE fields; hlSides is a fill COUNT, not a price -> left at 2.
function scaled(m) {
  return { gmxOpen: DEFAULT_COSTS.gmxOpen * m, gmxClose: DEFAULT_COSTS.gmxClose * m, gmxImpact: DEFAULT_COSTS.gmxImpact * m, gmxGas: DEFAULT_COSTS.gmxGas * m, hlTaker: DEFAULT_COSTS.hlTaker * m, hlSides: DEFAULT_COSTS.hlSides };
}
const MULTS = [0.5, 1, 2, 3, 5];

const rowsBy = {};
for (const a of ["APT", "BTC", "ETH"]) rowsBy[a] = loadRows(a);

console.log("=== round-trip cost by multiplier (roundTripCost, N=$2000) ===");
for (const m of MULTS) {
  const two = roundTripCost(scaled(m), N, false), one = roundTripCost(scaled(m), N, true);
  console.log(`x${m}: two-leg $${two.toFixed(4)} (${(100*two/N).toFixed(5)}%)  one-leg $${one.toFixed(4)} (${(100*one/N).toFixed(5)}%)`);
}

console.log("\n=== gross via paper ledger, then net at each multiplier ===");
const res = [];
for (const s of POSITIONS) {
  const r = runPaper(rowsBy[s.asset], s, CAP, LEV);
  const gross = r.summary.grossPnl;
  const isOne = s.strategy === "one";
  const nets = MULTS.map((m) => gross - roundTripCost(scaled(m), N, isOne));
  // break-even multiplier: gross = N*pct*m + gas*m  => m* = gross / (cost at m=1)
  const c1 = roundTripCost(scaled(1), N, isOne);
  const mStar = gross / c1;
  res.push({ label: s.label, gross, hours: r.applied.hoursApplied, gap: r.applied.gapSkippedSec, nets, mStar, c1 });
  console.log(`${s.label.padEnd(10)} gross $${gross.toFixed(2).padStart(9)} h=${r.applied.hoursApplied} gapSec=${r.applied.gapSkippedSec} | ` +
    MULTS.map((m, i) => `x${m}:$${nets[i].toFixed(2)}`).join("  ") + ` | breakeven mult = ${gross > 0 ? mStar.toFixed(2) : "already <0"}`);
}

console.log("\n=== fee-scale sensitivity of the CHOSEN live configs (BTC two-B, ETH two-A) ===");
for (const lbl of ["BTC two-B", "ETH two-A", "ETH one", "BTC one"]) {
  const r = res.find((x) => x.label === lbl);
  console.log(`${lbl}: gross $${r.gross.toFixed(2)}, 1x cost $${r.c1.toFixed(2)} (${(100*r.c1/r.gross).toFixed(2)}% of gross), net goes <=0 at multiplier ${r.gross>0? r.mStar.toFixed(2):"n/a"}`);
}

console.log("\n=== breakdown at 1x, N=$2000 ===");
console.log(JSON.stringify(roundTripCostBreakdown(DEFAULT_COSTS, N, false)), "two-leg");
console.log(JSON.stringify(roundTripCostBreakdown(DEFAULT_COSTS, N, true)), "one-leg");
