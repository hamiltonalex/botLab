// adv-12-costsplit.mjs - ИЗ ЧЕГО СОСТОИТ КРУГ ИЗДЕРЖЕК при фактическом размере $1995.
import { loadScan, makeEnv, sideOf, walk } from "./pf-walk.mjs";
import { loadCapacity, q, $ } from "./pf-lib.mjs";
import { interpBps, costAtSize } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS as C } from "../../src/engine/costs.js";
const scan = loadScan(process.env.FA_PF_SCAN);
const env = makeEnv(); const cap = loadCapacity();
const r = walk({ scan, env, capital: 2500, cadence: 24, kmax: 1, mode: "rule-1", first: 720, last: 720 + 7573 });
const sets = r.log.filter((l) => l.act === "set");
let g = { fee: 0, hl: 0, gas: 0, gimp: 0, himp: 0, tot: 0 };
for (const s of sets) {
  const tok = s.tokens; const S = s.usd;
  // сторона восстанавливается из скана по этому часу
  const ok = scan.get(s.t) || []; const c = ok.find((x) => x.k === tok);
  const imp = cap.impactFor(tok, sideOf(c ? c.c : "A"));
  g.fee += S * (C.gmxOpen + C.gmxClose) / 100;
  g.hl += S * (C.hlTaker * C.hlSides) / 100;
  g.gas += C.gmxGas;
  g.gimp += S * Math.max(0, interpBps(imp.gmxNodes, S)) / 1e4;
  g.himp += S * Math.max(0, interpBps(imp.hlNodes, S)) / 1e4;
  g.tot += costAtSize({ sizeUsd: S, costs: C, impact: imp });
}
const n = sets.length;
console.log("кругов", n, "медианный размер", $(q(sets.map((s) => s.usd), 0.5)));
for (const [k, v] of Object.entries(g)) console.log(" ", k.padEnd(5), $(v).padStart(9), "за круг", $(v / n).padStart(8), (100 * v / g.tot).toFixed(1) + "%");
console.log("издержки по ходоку", $(r.costs), "брутто", $(r.realized), "нетто", $(r.net));
console.log("плоский газ за прогон", $(g.gas), "=", (100 * g.gas / r.net).toFixed(1) + "% нетто");
