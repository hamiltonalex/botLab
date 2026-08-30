import { POSITIONS, loadRows, DEFAULT_COSTS, roundTripCost, openPosition, accrueFromRows, closePosition, positionSummary, accountSummary } from "./wf-cost-lib.mjs";

const CAP = 2000, LEV = 1, N = CAP * LEV;
const rowsBy = {}; for (const a of ["APT","BTC","ETH"]) rowsBy[a] = loadRows(a);

// Real rotation: split the year into k segments, each is its OWN paper position
// (openPosition -> accrueFromRows -> closePosition), so each pays its own roundTripCost.
function rotate(rows, spec, k) {
  const isOne = spec.strategy === "one";
  const total = rows.length;
  const per = Math.ceil(total / k);
  const positions = [];
  for (let i = 0; i < total; i += per) {
    const seg = rows.slice(i, Math.min(total, i + per));
    const t0 = seg[0].tsHour * 1000;
    const end = (seg[seg.length - 1].tsHour + 3600) * 1000;
    const p = openPosition({ strategy: spec.strategy, instrumentKey: spec.key, config: spec.config, capital: CAP, leverage: LEV, nowMs: t0, roundTripCost: roundTripCost(DEFAULT_COSTS, N, isOne) });
    accrueFromRows(p, seg, end);
    closePosition(p, end);
    positions.push(p);
  }
  const acc = accountSummary(positions);
  return { k: positions.length, gross: acc.grossPnl, net: acc.netPnl, costs: positions.length * roundTripCost(DEFAULT_COSTS, N, isOne) };
}

const SCHED = [ {name:"hold 1y", k:1}, {name:"quarterly", k:4}, {name:"monthly", k:12}, {name:"weekly", k:52}, {name:"daily", k:365} ];
console.log("=== rotation cost, $2000, 1x, real segmented paper positions ===");
console.log("position   | " + SCHED.map(s=>s.name.padStart(11)).join(" | "));
const grossBy = {};
for (const s of POSITIONS) {
  const out = SCHED.map(sc => rotate(rowsBy[s.asset], s, sc.k));
  grossBy[s.label] = out[0].gross;
  console.log(s.label.padEnd(10) + " | " + out.map(o => `$${o.net.toFixed(2)}`.padStart(11)).join(" | "));
}
console.log("\n(gross is identical across schedules by construction: continuous re-entry, same rows)");
for (const s of POSITIONS.slice(0,3)) { const o1 = rotate(rowsBy[s.asset], s, 1), o52 = rotate(rowsBy[s.asset], s, 52); console.log(`  check ${s.label}: gross k=1 $${o1.gross.toFixed(4)} vs k=52 $${o52.gross.toFixed(4)}`); }

console.log("\n=== how many round trips a year zero the carry (N* = gross / roundTripCost) ===");
for (const s of POSITIONS) {
  const isOne = s.strategy === "one";
  const c = roundTripCost(DEFAULT_COSTS, N, isOne);
  const g = grossBy[s.label];
  console.log(`${s.label.padEnd(10)} gross $${g.toFixed(2).padStart(9)}  rt $${c.toFixed(2)}  N* = ${g>0 ? (g/c).toFixed(2) : "n/a (gross<0)"} round trips/yr`);
}

console.log("\n=== nominal-carry version (the 2.6%/yr number for live BTC+ETH) ===");
for (const apr of [0.026, 0.0302, 0.0297, 0.053, 0.10, 0.53]) {
  const carry = apr * N;
  const c2 = roundTripCost(DEFAULT_COSTS, N, false), c1 = roundTripCost(DEFAULT_COSTS, N, true);
  console.log(`carry ${(apr*100).toFixed(2)}%/yr = $${carry.toFixed(2)}: two-leg N* = ${(carry/c2).toFixed(2)} rt/yr (one every ${(365/(carry/c2)).toFixed(1)} d) | one-leg N* = ${(carry/c1).toFixed(2)} rt/yr (every ${(365/(carry/c1)).toFixed(1)} d)`);
}
