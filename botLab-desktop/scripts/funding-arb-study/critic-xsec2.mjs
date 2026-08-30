import * as L from "./critic-lib.mjs";
import { annualizeRow, maxOf, median } from "../../src/engine/math.js";

const all = L.loadAll();
const FULL = [...all.entries()].filter(([t, r]) => r.length === 8761).map(([t]) => t).sort();
const ROWS = new Map(FULL.map((t) => [t, all.get(t)]));
const H1 = 24;

// "Sane market" proxy from the data itself: peak hourly |net APR| over the year, via annualizeRow.
const peak = new Map();
for (const t of FULL) {
  const ann = ROWS.get(t).map(annualizeRow);
  peak.set(t, maxOf(ann.map((a) => Math.max(Math.abs(a.net_A), Math.abs(a.net_B)))));
}
const sorted = [...peak.entries()].sort((a, b) => a[1] - b[1]);
console.log("### peak hourly |net APR| over the year, per token (engine annualizeRow) - 10 calmest / 10 wildest");
sorted.slice(0, 10).forEach(([t, v]) => console.log(`  calm  ${t.padEnd(10)} ${v.toFixed(2)}`));
sorted.slice(-10).forEach(([t, v]) => console.log(`  wild  ${t.padEnd(10)} ${v.toFixed(2)}`));

function scanKey(scan, key) { const b = scan.chosen === "A" ? scan.A : scan.B; return key === "median" ? b.netMedian : b.netMean; }

function xwf({ tokens, W, H, N, key = "median", gate = 0, capital = 2000 }) {
  const trainH = W * H1, holdH = H * H1, perPos = capital / N;
  let gross = 0, entries = 0, slots = 0, periods = 0, hoursDeployed = 0, prev = new Set();
  const picks = [], perPeriodNet = [];
  const rtPer = L.roundTripCost(L.DEFAULT_COSTS, perPos, false);
  for (let i = trainH; i < 8761; i += holdH) {
    const te = Math.min(8761, i + holdH);
    if (te - i < 24) break;
    const ranked = [];
    for (const t of tokens) {
      const sc = L.scanTwoLeg(ROWS.get(t).slice(i - trainH, i), { token: t });
      if (!sc) continue;
      const v = scanKey(sc, key);
      if (Number.isFinite(v) && v > gate) ranked.push({ t, cfg: sc.chosen, v });
    }
    ranked.sort((a, b) => b.v - a.v);
    const sel = ranked.slice(0, N);
    let pg = 0, pe = 0;
    for (const s of sel) {
      const { s: sum, applied } = L.runPos({ rows: ROWS.get(s.t).slice(i, te), token: s.t, config: s.cfg, capital: perPos, payCost: false });
      if (applied.gapSkippedSec !== 0) throw new Error("gap");
      gross += sum.grossPnl; pg += sum.grossPnl; slots++;
      if (!prev.has(s.t + s.cfg)) { entries++; pe++; }
    }
    perPeriodNet.push(pg - pe * rtPer);
    prev = new Set(sel.map((s) => s.t + s.cfg));
    picks.push(sel.map((s) => s.t + s.cfg).join(","));
    periods++; hoursDeployed = te - trainH;
  }
  const yrs = hoursDeployed / 8760;
  const netCarry = gross - entries * rtPer, netNaive = gross - slots * rtPer;
  return { periods, entries, slots, gross, netNaive, netCarry, aprNaive: netNaive / capital / yrs, aprCarry: netCarry / capital / yrs, picks, perPeriodNet, rtPer };
}

const fm = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);
const pc = (x) => (x >= 0 ? "+" : "") + (100 * x).toFixed(2) + "%";

const MAJORS = ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC","BCH","DOT","ATOM","ARB","OP","NEAR","SUI","TRX","UNI","AAVE","XLM","HBAR","TAO","FIL"].filter((t) => ROWS.has(t));
const CALM = FULL.filter((t) => peak.get(t) < 5);      // never above 500% APR in any hour
const CALM2 = FULL.filter((t) => peak.get(t) < 20);

console.log(`\n### E. Universe variants. MAJORS(${MAJORS.length}) | peak<5 (${CALM.length}): ${CALM.join(" ")} | peak<20 (${CALM2.length})`);
console.log("universe   W  H   N  periods entries gross$     net(carry)$ APR(carry)  net(naive)$ APR(naive)");
for (const [nm, U] of [["MAJORS", MAJORS], ["peak<5", CALM], ["peak<20", CALM2], ["ALL63", FULL]])
for (const [W, H, N] of [[90, 30, 3], [90, 90, 3], [30, 30, 5], [90, 30, 5]]) {
  const r = xwf({ tokens: U, W, H, N });
  console.log(`${nm.padEnd(11)}${String(W).padEnd(3)}${String(H).padEnd(4)}${String(N).padEnd(3)}${String(r.periods).padEnd(8)}${String(r.entries).padEnd(8)}${fm(r.gross).padEnd(11)}${fm(r.netCarry).padEnd(12)}${pc(r.aprCarry).padEnd(12)}${fm(r.netNaive).padEnd(12)}${pc(r.aprNaive)}`);
}

console.log("\n### F. picks, MAJORS W=90 H=30 N=3, and per-period net $");
const rm = xwf({ tokens: MAJORS, W: 90, H: 30, N: 3 });
rm.picks.forEach((p, i) => console.log(`  p${i + 1}: ${p.padEnd(28)} net ${fm(rm.perPeriodNet[i])}`));
console.log("\n### G. picks, peak<5 universe W=90 H=30 N=3");
const rc = xwf({ tokens: CALM, W: 90, H: 30, N: 3 });
rc.picks.forEach((p, i) => console.log(`  p${i + 1}: ${p.padEnd(28)} net ${fm(rc.perPeriodNet[i])}`));

// Control: equal-weight ALL tokens of a universe, held the whole year, config from first 30d (honest).
console.log("\n### H. Control: buy-and-hold the WHOLE universe equal-weight, config chosen on first 30 days only");
for (const [nm, U] of [["MAJORS", MAJORS], ["peak<5", CALM], ["ALL63", FULL]]) {
  const per = 2000 / U.length;
  let gross = 0;
  for (const t of U) {
    const sc = L.scanTwoLeg(ROWS.get(t).slice(0, 720), { token: t });
    const { s } = L.runPos({ rows: ROWS.get(t).slice(720), token: t, config: sc.chosen, capital: per, payCost: false });
    gross += s.grossPnl;
  }
  const rt = L.roundTripCost(L.DEFAULT_COSTS, per, false) * U.length;
  const yrs = (8761 - 720) / 8760;
  console.log(`  ${nm.padEnd(8)} n=${String(U.length).padEnd(3)} per-pos $${per.toFixed(2).padEnd(8)} gross ${fm(gross).padEnd(11)} cost ${rt.toFixed(2).padEnd(9)} net ${fm(gross - rt).padEnd(11)} APR ${pc((gross - rt) / 2000 / yrs)}`);
}
