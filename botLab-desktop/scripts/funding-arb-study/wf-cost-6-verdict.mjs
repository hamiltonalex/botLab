import { POSITIONS, loadRows, runPaper, DEFAULT_COSTS, roundTripCost } from "./wf-cost-lib.mjs";
const rowsBy={}; for(const a of ["BTC","ETH"]) rowsBy[a]=loadRows(a);
const CAP=2000;
const honest={...DEFAULT_COSTS,gmxGas:2.0};
console.log("=== verdict cases ===");
for (const [lbl,lev] of [["BTC two-B",1],["ETH two-A",1],["BTC two-B",0.5],["ETH two-A",0.5]]) {
  const s=POSITIONS.find(p=>p.label===lbl);
  const q=runPaper(rowsBy[s.asset],s,CAP,lev).summary;
  const N=CAP*lev;
  for (const k of [1,4,8]) {
    const c=roundTripCost(honest,N,false);
    const net=q.grossPnl-k*c;
    console.log(`${lbl} lev=${lev} rotations=${k}: gross $${q.grossPnl.toFixed(2)} rt(honest gas x2) $${c.toFixed(2)} net $${net.toFixed(2)} = ${(100*net/CAP).toFixed(3)}% on the $2000 account`);
  }
}
