import * as L from "./critic-lib.mjs";
import fs from "node:fs";
const rowsOf = (t) => L.parseSpreadCsv(fs.readFileSync(`${L.FIX}/${t}.csv`, "utf8"));
const R = { BTC: rowsOf("BTC"), ETH: rowsOf("ETH"), APT: rowsOf("APT") };
const H1 = 24, CAP = 2000;
const pc = (x) => (x >= 0 ? "+" : "") + (100 * x).toFixed(2) + "%";
const fm = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);

// Threshold gate: hold only while trailing-W median net APR of the chosen config exceeds tau.
// Cost charged only when the position is (re)opened or the side flips.
function gated({ tok, W, H, tau, key = "median" }) {
  const rows = R[tok], trainH = W * H1, holdH = H * H1;
  const rt = L.roundTripCost(L.DEFAULT_COSTS, CAP, false);
  let gross = 0, entries = 0, held = 0, slots = 0, prev = null, hoursDeployed = 0;
  for (let i = trainH; i < 8761; i += holdH) {
    const te = Math.min(8761, i + holdH); if (te - i < 24) break;
    slots++; hoursDeployed = te - trainH;
    const sc = L.scanTwoLeg(rows.slice(i - trainH, i), { token: tok });
    const b = sc.chosen === "A" ? sc.A : sc.B;
    const v = key === "median" ? b.netMedian : b.netMean;
    if (!(v > tau)) { prev = null; continue; }
    const { s } = L.runPos({ rows: rows.slice(i, te), token: tok, config: sc.chosen, capital: CAP, payCost: false });
    gross += s.grossPnl; held++;
    if (prev !== sc.chosen) entries++;
    prev = sc.chosen;
  }
  const yrs = hoursDeployed / 8760;
  const net = gross - entries * rt;
  return { held, slots, entries, gross, net, apr: net / CAP / yrs };
}

console.log("### M. Entry threshold gate on the CURRENT live universe (BTC, ETH), $2000, cost only on (re)entry");
console.log("tok W   H   tau     held/slots entries gross$   net$     APR");
for (const tok of ["BTC", "ETH"])
for (const W of [30, 90]) for (const H of [30, 90]) for (const tau of [0, 0.02, 0.05, 0.10, 0.20]) {
  const r = gated({ tok, W, H, tau });
  console.log(`${tok.padEnd(4)}${String(W).padEnd(4)}${String(H).padEnd(4)}${tau.toFixed(2).padEnd(8)}${(r.held + "/" + r.slots).padEnd(11)}${String(r.entries).padEnd(8)}${fm(r.gross).padEnd(9)}${fm(r.net).padEnd(9)}${pc(r.apr)}`);
}
console.log("\n### N. same gate on APT (dead market, control that the gate mechanism works)");
for (const W of [90]) for (const H of [30]) for (const tau of [0, 0.05, 0.20, 0.40]) {
  const r = gated({ tok: "APT", W, H, tau });
  console.log(`APT ${W} ${H} tau=${tau}: held ${r.held}/${r.slots} entries ${r.entries} gross ${fm(r.gross)} net ${fm(r.net)} APR ${pc(r.apr)}`);
}
