import * as L from "./critic-lib.mjs";
import { annualizeRow, maxOf } from "../../src/engine/math.js";

const all = L.loadAll();
const FULL = [...all.entries()].filter(([t, r]) => r.length === 8761).map(([t]) => t).sort();
const ROWS = new Map(FULL.map((t) => [t, all.get(t)]));
const H1 = 24;
const MAJORS = ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC","BCH","DOT","ATOM","ARB","OP","NEAR","SUI","TRX","UNI","AAVE","XLM","HBAR","TAO","FIL"].filter((t) => ROWS.has(t));
const peak = new Map(FULL.map((t) => [t, maxOf(ROWS.get(t).map(annualizeRow).map((a) => Math.max(Math.abs(a.net_A), Math.abs(a.net_B))))]));

function xwf({ tokens, W, H, N, key = "median", capital = 2000, costMult = 1 }) {
  const trainH = W * H1, holdH = H * H1, perPos = capital / N;
  const costs = { ...L.DEFAULT_COSTS, gmxOpen: L.DEFAULT_COSTS.gmxOpen * costMult, gmxClose: L.DEFAULT_COSTS.gmxClose * costMult, gmxImpact: L.DEFAULT_COSTS.gmxImpact * costMult, gmxGas: L.DEFAULT_COSTS.gmxGas * costMult, hlTaker: L.DEFAULT_COSTS.hlTaker * costMult };
  const rtPer = L.roundTripCost(costs, perPos, false);
  let gross = 0, entries = 0, slots = 0, periods = 0, hoursDeployed = 0, prev = new Set();
  const perPeriodNet = [], tokGross = new Map();
  for (let i = trainH; i < 8761; i += holdH) {
    const te = Math.min(8761, i + holdH); if (te - i < 24) break;
    const ranked = [];
    for (const t of tokens) {
      const sc = L.scanTwoLeg(ROWS.get(t).slice(i - trainH, i), { token: t }); if (!sc) continue;
      const b = sc.chosen === "A" ? sc.A : sc.B; const v = key === "median" ? b.netMedian : b.netMean;
      if (Number.isFinite(v) && v > 0) ranked.push({ t, cfg: sc.chosen, v });
    }
    ranked.sort((a, b) => b.v - a.v);
    const sel = ranked.slice(0, N); let pg = 0, pe = 0;
    for (const s of sel) {
      const { s: sum } = L.runPos({ rows: ROWS.get(s.t).slice(i, te), token: s.t, config: s.cfg, capital: perPos, payCost: false });
      gross += sum.grossPnl; pg += sum.grossPnl; slots++;
      tokGross.set(s.t, (tokGross.get(s.t) || 0) + sum.grossPnl);
      if (!prev.has(s.t + s.cfg)) { entries++; pe++; }
    }
    perPeriodNet.push(pg - pe * rtPer);
    prev = new Set(sel.map((s) => s.t + s.cfg)); periods++; hoursDeployed = te - trainH;
  }
  const yrs = hoursDeployed / 8760, netCarry = gross - entries * rtPer, netNaive = gross - slots * rtPer;
  return { periods, entries, gross, netCarry, netNaive, aprCarry: netCarry / capital / yrs, aprNaive: netNaive / capital / yrs, perPeriodNet, tokGross };
}
const pc = (x) => (x >= 0 ? "+" : "") + (100 * x).toFixed(2) + "%";
const fm = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);

console.log("### I. MAJORS grid (24 names), capital $2000, APR net with carry-cost model / naive / +pos periods");
console.log("key     W   H   N   APR(carry) APR(naive) periods  +periods");
for (const key of ["median", "mean"])
for (const W of [30, 60, 90, 180]) for (const H of [30, 60, 90]) for (const N of [1, 3, 5, 8]) {
  const r = xwf({ tokens: MAJORS, W, H, N, key });
  const pos = r.perPeriodNet.filter((x) => x > 0).length;
  console.log(`${key.padEnd(8)}${String(W).padEnd(4)}${String(H).padEnd(4)}${String(N).padEnd(4)}${pc(r.aprCarry).padEnd(11)}${pc(r.aprNaive).padEnd(11)}${String(r.periods).padEnd(9)}${pos}/${r.periods}`);
}

console.log("\n### J. MAJORS W=90 H=30 N=3: cost stress and capital scale");
for (const m of [1, 2, 3]) for (const cap of [2000, 10000]) {
  const r = xwf({ tokens: MAJORS, W: 90, H: 30, N: 3, capital: cap, costMult: m });
  console.log(`  costs x${m}  capital $${cap}: gross ${fm(r.gross)}  net(carry) ${fm(r.netCarry)}  APR ${pc(r.aprCarry)}  net(naive) ${fm(r.netNaive)} APR ${pc(r.aprNaive)}`);
}

console.log("\n### K. MAJORS W=90 H=30 N=3: gross by token, and leave-one-out APR(carry)");
const base = xwf({ tokens: MAJORS, W: 90, H: 30, N: 3 });
[...base.tokGross.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, g]) => console.log(`   ${t.padEnd(6)} gross ${fm(g).padStart(9)}   peak|netAPR| ${peak.get(t).toFixed(1)}`));
console.log("  leave-one-out:");
for (const drop of [...base.tokGross.keys()]) {
  const r = xwf({ tokens: MAJORS.filter((t) => t !== drop), W: 90, H: 30, N: 3 });
  console.log(`   without ${drop.padEnd(6)} APR(carry) ${pc(r.aprCarry)}  net ${fm(r.netCarry)}`);
}
const noTop3 = MAJORS.filter((t) => !["FIL", "TRX", "OP"].includes(t));
const r3 = xwf({ tokens: noTop3, W: 90, H: 30, N: 3 });
console.log(`  without FIL+TRX+OP: APR(carry) ${pc(r3.aprCarry)} net ${fm(r3.netCarry)}  +periods ${r3.perPeriodNet.filter(x=>x>0).length}/${r3.periods}`);

console.log("\n### L. Same MAJORS rule but ONE-LEG (GMX carry only), W=90 H=30 N=3, ranked by scanOneLeg netMedian");
{
  const trainH = 90 * H1, holdH = 30 * H1, perPos = 2000 / 3;
  const rt = L.roundTripCost(L.DEFAULT_COSTS, perPos, true);
  let gross = 0, entries = 0, prev = new Set(), periods = 0, hoursDeployed = 0;
  const pp = [];
  for (let i = trainH; i < 8761; i += holdH) {
    const te = Math.min(8761, i + holdH); if (te - i < 24) break;
    const ranked = [];
    for (const t of MAJORS) { const sc = L.scanOneLeg(ROWS.get(t).slice(i - trainH, i), { token: t }); if (sc && sc.netMedian > 0) ranked.push({ t, v: sc.netMedian }); }
    ranked.sort((a, b) => b.v - a.v);
    const sel = ranked.slice(0, 3); let pg = 0, pe = 0;
    for (const s of sel) { const { s: sum } = L.runPos({ rows: ROWS.get(s.t).slice(i, te), token: s.t, config: null, strategy: "one", capital: perPos, payCost: false }); gross += sum.grossPnl; pg += sum.grossPnl; if (!prev.has(s.t)) { entries++; pe++; } }
    pp.push(pg - pe * rt); prev = new Set(sel.map((s) => s.t)); periods++; hoursDeployed = te - trainH;
  }
  const yrs = hoursDeployed / 8760;
  console.log(`  gross ${fm(gross)} entries ${entries} net(carry) ${fm(gross - entries * rt)} APR ${pc((gross - entries * rt) / 2000 / yrs)} +periods ${pp.filter(x=>x>0).length}/${periods}`);
}

console.log("\n### O. MAJORS minus every name whose peak hourly |net APR| exceeds 30 (drops the FIL/BCH-type spikes)");
const TAME = MAJORS.filter((t) => peak.get(t) <= 30);
console.log("  universe:", TAME.join(" "), `(${TAME.length} names)`);
for (const [W,H,N] of [[30,30,3],[60,30,3],[90,30,3],[90,30,5],[90,90,3],[180,30,3]]) {
  const r = xwf({ tokens: TAME, W, H, N });
  console.log(`  W=${W} H=${H} N=${N}: gross ${fm(r.gross)} net(carry) ${fm(r.netCarry)} APR ${pc(r.aprCarry)} naive ${pc(r.aprNaive)} +periods ${r.perPeriodNet.filter(x=>x>0).length}/${r.periods}`);
}
const rT = xwf({ tokens: TAME, W: 90, H: 30, N: 3 });
console.log("  gross by token:", [...rT.tokGross.entries()].sort((a,b)=>b[1]-a[1]).map(([t,g])=>`${t} ${fm(g)}`).join("  "));
