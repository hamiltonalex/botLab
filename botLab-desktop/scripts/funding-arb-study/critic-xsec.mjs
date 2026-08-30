import * as L from "./critic-lib.mjs";

const all = L.loadAll();
const FULL = [...all.entries()].filter(([t, r]) => r.length === 8761).map(([t]) => t).sort();
const ROWS = new Map(FULL.map((t) => [t, all.get(t)]));
const H1 = 24;

// My own liquid list (declared as an assumption, not a measurement): large perp names.
const LIQUID = ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC","BCH","DOT","ATOM","APT","ARB","OP","NEAR","SUI","TRX","UNI","AAVE","HYPE","TAO","FIL","INJ","TIA","ONDO","PEPE","SHIB","WLD"].filter((t) => ROWS.has(t));

function scanKey(scan, key) {
  const blk = scan.chosen === "A" ? scan.A : scan.B;
  return key === "median" ? blk.netMedian : blk.netMean;
}

// Cross-sectional walk-forward. Returns aggregate over the deployed window.
function xwf({ tokens, W, H, N, key = "median", gate = 0, capital = 2000, minRank = -Infinity }) {
  const trainH = W * H1, holdH = H * H1;
  const perPosCapital = capital / N;
  let gross = 0, periods = 0, slotsFilled = 0, hoursDeployed = 0;
  let prevSel = new Set();
  let entries = 0, slotCharges = 0;
  const picks = [];
  for (let i = trainH; i < 8761; i += holdH) {
    const tradeEnd = Math.min(8761, i + holdH);
    if (tradeEnd - i < 24) break;
    const ranked = [];
    for (const t of tokens) {
      const scan = L.scanTwoLeg(ROWS.get(t).slice(i - trainH, i), { token: t });
      if (!scan) continue;
      const v = scanKey(scan, key);
      if (!Number.isFinite(v)) continue;
      if (v <= gate) continue;
      ranked.push({ t, cfg: scan.chosen, v });
    }
    ranked.sort((a, b) => b.v - a.v);
    const sel = ranked.slice(0, N);
    const selKeys = new Set(sel.map((s) => s.t + s.cfg));
    for (const s of sel) {
      const trade = ROWS.get(s.t).slice(i, tradeEnd);
      const { s: sum, applied } = L.runPos({ rows: trade, token: s.t, config: s.cfg, capital: perPosCapital, payCost: false });
      if (applied.gapSkippedSec !== 0) throw new Error("gap");
      gross += sum.grossPnl;
      slotsFilled++;
      slotCharges++;
      if (!prevSel.has(s.t + s.cfg)) entries++;
    }
    hoursDeployed = tradeEnd - trainH;
    prevSel = selKeys;
    periods++;
    picks.push(sel.map((s) => s.t + s.cfg).join(","));
  }
  const rtPer = L.roundTripCost(L.DEFAULT_COSTS, perPosCapital, false);
  const costNaive = slotCharges * rtPer;
  const costCarry = entries * rtPer;
  const yrs = hoursDeployed / 8760;
  return {
    W, H, N, key, capital, periods, slotsFilled, entries,
    gross, netNaive: gross - costNaive, netCarry: gross - costCarry,
    rtPer, costNaive, costCarry,
    aprNaive: (gross - costNaive) / capital / yrs, aprCarry: (gross - costCarry) / capital / yrs,
    hoursDeployed, picks,
  };
}

const fm = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);
const pc = (x) => (x >= 0 ? "+" : "") + (100 * x).toFixed(2) + "%";

console.log("### A. Cross-sectional walk-forward, ALL 63 full-year tokens, capital $2000");
console.log("W  H   N  key     periods entries gross$    net(naive)$ APR      net(carry)$ APR      rt/pos$");
for (const key of ["median", "mean"])
for (const W of [30, 90])
for (const H of [30, 90])
for (const N of [1, 3, 5, 10]) {
  const r = xwf({ tokens: FULL, W, H, N, key });
  console.log(`${String(W).padEnd(3)}${String(H).padEnd(4)}${String(N).padEnd(3)}${key.padEnd(8)}${String(r.periods).padEnd(8)}${String(r.entries).padEnd(8)}${fm(r.gross).padEnd(10)}${fm(r.netNaive).padEnd(12)}${pc(r.aprNaive).padEnd(9)}${fm(r.netCarry).padEnd(12)}${pc(r.aprCarry).padEnd(9)}${r.rtPer.toFixed(3)}`);
}

console.log("\n### B. Same, capital $20000 (fixed $1 gas diluted)");
console.log("W  H   N  key     periods entries gross$    net(naive)$ APR      net(carry)$ APR      rt/pos$");
for (const key of ["median"])
for (const W of [30, 90])
for (const H of [30, 90])
for (const N of [1, 3, 5, 10]) {
  const r = xwf({ tokens: FULL, W, H, N, key, capital: 20000 });
  console.log(`${String(W).padEnd(3)}${String(H).padEnd(4)}${String(N).padEnd(3)}${key.padEnd(8)}${String(r.periods).padEnd(8)}${String(r.entries).padEnd(8)}${fm(r.gross).padEnd(10)}${fm(r.netNaive).padEnd(12)}${pc(r.aprNaive).padEnd(9)}${fm(r.netCarry).padEnd(12)}${pc(r.aprCarry).padEnd(9)}${r.rtPer.toFixed(3)}`);
}

console.log("\n### C. Restricted to my liquid list (" + LIQUID.length + " names: " + LIQUID.join(" ") + "), capital $2000");
console.log("W  H   N  key     periods entries gross$    net(naive)$ APR      net(carry)$ APR");
for (const W of [30, 90])
for (const H of [30, 90])
for (const N of [1, 3, 5]) {
  const r = xwf({ tokens: LIQUID, W, H, N, key: "median" });
  console.log(`${String(W).padEnd(3)}${String(H).padEnd(4)}${String(N).padEnd(3)}${"median".padEnd(8)}${String(r.periods).padEnd(8)}${String(r.entries).padEnd(8)}${fm(r.gross).padEnd(10)}${fm(r.netNaive).padEnd(12)}${pc(r.aprNaive).padEnd(9)}${fm(r.netCarry).padEnd(12)}${pc(r.aprCarry)}`);
}

console.log("\n### D. Which tokens the rule actually picks (W=90 H=30 N=5 median, all 63)");
const d = xwf({ tokens: FULL, W: 90, H: 30, N: 5, key: "median" });
d.picks.forEach((p, i) => console.log(`  period ${i + 1}: ${p}`));
