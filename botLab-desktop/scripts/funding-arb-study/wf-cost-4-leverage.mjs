import { POSITIONS, loadRows, runPaper, scanTwoLeg, scanOneLeg, maxDrawdownFraction, pnlPath, roundTripCost, DEFAULT_COSTS } from "./wf-cost-lib.mjs";
const rowsBy = {}; for (const a of ["APT","BTC","ETH"]) rowsBy[a] = loadRows(a);
const CAP = 2000;
const LEVS = [1, 2, 3, 5, 10];

console.log("=== leverage on $2000 capital: return ON CAPITAL and drawdown ON CAPITAL (real ledger) ===");
for (const s of POSITIONS) {
  const parts = [];
  for (const L of LEVS) {
    const r = runPaper(rowsBy[s.asset], s, CAP, L);
    const q = r.summary;
    parts.push({ L, net: q.netPnl, ret: q.ret, rt: q.roundTripCost, ddUsd: q.maxDrawdown, ddNot: q.maxDrawdownPct, ddCap: Math.abs(q.maxDrawdown)/CAP });
  }
  console.log(`\n${s.label}  (dd as fraction of NOTIONAL is constant: ${(100*parts[0].ddNot).toFixed(3)}%)`);
  for (const p of parts) {
    console.log(`  ${String(p.L).padStart(2)}x: rt $${p.rt.toFixed(2).padStart(8)}  net $${p.net.toFixed(2).padStart(11)}  ret on capital ${(100*p.ret).toFixed(3).padStart(9)}%  maxDD $${p.ddUsd.toFixed(2).padStart(10)} = ${(100*p.ddCap).toFixed(2).padStart(8)}% of capital`);
  }
}

console.log("\n=== cross-check of dd fraction against math.js maxDrawdownFraction on the annualized net series ===");
for (const a of ["APT","BTC","ETH"]) {
  const t = scanTwoLeg(rowsBy[a], { token: a });
  const o = scanOneLeg(rowsBy[a], { token: a });
  console.log(`${a}: scanTwoLeg chosen=${t.chosen} ddA=${(100*maxDrawdownFraction(t.seriesA)).toFixed(3)}% ddB=${(100*maxDrawdownFraction(t.seriesB)).toFixed(3)}% one=${(100*maxDrawdownFraction(o.net)).toFixed(3)}%  | pnlPath total A $${pnlPath(t.seriesA,2000).total.toFixed(2)} B $${pnlPath(t.seriesB,2000).total.toFixed(2)} one $${pnlPath(o.net,2000).total.toFixed(2)}`);
}

console.log("\n=== leverage at which the year's max drawdown equals 100% of capital (paper P&L only, no price risk) ===");
for (const s of POSITIONS) {
  const r = runPaper(rowsBy[s.asset], s, CAP, 1);
  const f = r.summary.maxDrawdownPct;
  console.log(`${s.label.padEnd(10)} ddNotional ${(100*f).toFixed(3)}%  -> wipeout leverage ${f>0 ? (1/f).toFixed(1)+"x" : "n/a"}`);
}
