import { POSITIONS, loadRows, runPaper, DEFAULT_COSTS, roundTripCost, openPosition, accrueFromRows, closePosition, accountSummary, positionSummary } from "./wf-cost-lib.mjs";
const rowsBy = {}; for (const a of ["APT","BTC","ETH"]) rowsBy[a] = loadRows(a);
const CAP = 2000, N = 2000;
function scaled(m){return {gmxOpen:DEFAULT_COSTS.gmxOpen*m,gmxClose:DEFAULT_COSTS.gmxClose*m,gmxImpact:DEFAULT_COSTS.gmxImpact*m,gmxGas:DEFAULT_COSTS.gmxGas*m,hlTaker:DEFAULT_COSTS.hlTaker*m,hlSides:DEFAULT_COSTS.hlSides};}

console.log("=== net % on capital, grid: cost multiplier x rotations/yr ($2000, 1x) ===");
const MULT=[1,1.5,2,3,5], KS=[1,2,4,6,8,12,52];
for (const lbl of ["BTC two-B","ETH two-A","ETH one"]) {
  const s = POSITIONS.find(p=>p.label===lbl);
  const gross = runPaper(rowsBy[s.asset], s, CAP, 1).summary.grossPnl;
  const isOne = s.strategy==="one";
  console.log(`\n${lbl} (gross $${gross.toFixed(2)} = ${(100*gross/CAP).toFixed(3)}% on capital)`);
  console.log("  cost\\rot " + KS.map(k=>String(k).padStart(9)).join(""));
  for (const m of MULT) {
    const c = roundTripCost(scaled(m), N, isOne);
    console.log(`  x${String(m).padEnd(4)}   ` + KS.map(k=>((100*(gross-k*c)/CAP).toFixed(2)+"%").padStart(9)).join(""));
  }
}

console.log("\n=== 'structurally honest' variant: keeper gas charged on BOTH open and close (gmxGas 1 -> 2) ===");
const honest = {...DEFAULT_COSTS, gmxGas: 2.0};
for (const lbl of ["BTC two-B","ETH two-A"]) {
  const s = POSITIONS.find(p=>p.label===lbl);
  const gross = runPaper(rowsBy[s.asset], s, CAP, 1).summary.grossPnl;
  const c0 = roundTripCost(DEFAULT_COSTS, N, false), c1 = roundTripCost(honest, N, false);
  console.log(`${lbl}: rt $${c0.toFixed(2)} -> $${c1.toFixed(2)}; net 1 rt/yr ${(100*(gross-c0)/CAP).toFixed(3)}% -> ${(100*(gross-c1)/CAP).toFixed(3)}%; rotation budget ${(gross/c0).toFixed(2)} -> ${(gross/c1).toFixed(2)} rt/yr`);
}

console.log("\n=== collateral question: notional = capital x leverage is used for BOTH legs ===");
console.log("i.e. at leverage 1 a $2000 account runs $2000 GMX notional AND $2000 HL notional.");
console.log("If both legs must be fully collateralised out of the same $2000, the honest per-leg-1x run is leverage 0.5:");
for (const lbl of ["BTC two-B","ETH two-A"]) {
  const s = POSITIONS.find(p=>p.label===lbl);
  for (const L of [1, 0.5]) {
    const q = runPaper(rowsBy[s.asset], s, CAP, L).summary;
    console.log(`  ${lbl} lev=${L}: notional $${(CAP*L).toFixed(0)} per leg, gross $${q.grossPnl.toFixed(2)}, rt $${q.roundTripCost.toFixed(2)}, net $${q.netPnl.toFixed(2)} = ${(100*q.ret).toFixed(3)}% on the $2000 account`);
  }
}
