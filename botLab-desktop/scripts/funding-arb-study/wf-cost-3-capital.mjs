import { POSITIONS, loadRows, runPaper, DEFAULT_COSTS, roundTripCost, roundTripCostBreakdown } from "./wf-cost-lib.mjs";
const rowsBy = {}; for (const a of ["APT","BTC","ETH"]) rowsBy[a] = loadRows(a);
const CAPS = [100, 500, 2000, 10000, 100000];

console.log("=== round-trip cost vs capital (1x), roundTripCost + roundTripCostBreakdown ===");
for (const C of CAPS) {
  for (const isOne of [false, true]) {
    const c = roundTripCost(DEFAULT_COSTS, C, isOne);
    const b = roundTripCostBreakdown(DEFAULT_COSTS, C, isOne);
    const gasShare = b.gmxGasUsd / c;
    console.log(`$${String(C).padStart(6)} ${isOne?"one":"two"}-leg: rt $${c.toFixed(4).padStart(10)} = ${(100*c/C).toFixed(4)}% of notional | gas $${b.gmxGasUsd} = ${(100*gasShare).toFixed(2)}% of the round trip`);
  }
}

console.log("\n=== the fixed $1 vs the annual carry it has to come out of ===");
for (const apr of [0.026, 0.0302, 0.0297]) {
  console.log(`-- carry ${(apr*100).toFixed(2)}%/yr --`);
  for (const C of CAPS) {
    const carry = apr * C, c = roundTripCost(DEFAULT_COSTS, C, false);
    console.log(`  $${String(C).padStart(6)}: carry/yr $${carry.toFixed(2).padStart(9)} | rt $${c.toFixed(2).padStart(8)} = ${(100*c/carry).toFixed(1)}% of the year's carry | gas alone = ${(100*1/carry).toFixed(1)}% | net/yr (1 rt) $${(carry-c).toFixed(2).padStart(9)} = ${(100*(carry-c)/C).toFixed(3)}% on capital`);
  }
}

console.log("\n=== real ledger at each capital (openPosition/accrueFromRows/positionSummary), 1x, 1 round trip ===");
for (const lbl of ["BTC two-B","ETH two-A","ETH one","APT two-A"]) {
  const s = POSITIONS.find(p=>p.label===lbl);
  console.log(`-- ${lbl} --`);
  for (const C of CAPS) {
    const r = runPaper(rowsBy[s.asset], s, C, 1);
    const q = r.summary;
    console.log(`  $${String(C).padStart(6)}: gross $${q.grossPnl.toFixed(2).padStart(11)} rt $${q.roundTripCost.toFixed(2).padStart(9)} net $${q.netPnl.toFixed(2).padStart(11)} = ${(100*q.ret).toFixed(3)}% on capital (aprGross ${(100*q.aprGross).toFixed(3)}%)`);
  }
}

console.log("\n=== thresholds for the flat $1 (two-leg, gmxPct+hlPct = 0.31%) ===");
for (const target of [0.5, 0.2, 0.10, 0.05, 0.01]) {
  // gas share = 1 / (0.0031*N + 1) = target  =>  N = (1/target - 1)/0.0031
  let lo=1, hi=1e9;
  for(let i=0;i<200;i++){const mid=(lo+hi)/2; const b=roundTripCostBreakdown(DEFAULT_COSTS,mid,false); const sh=b.gmxGasUsd/roundTripCost(DEFAULT_COSTS,mid,false); if(sh>target) lo=mid; else hi=mid;}
  console.log(`  gas is ${(target*100).toFixed(0)}% of the round trip at notional $${lo.toFixed(0)}`);
}
