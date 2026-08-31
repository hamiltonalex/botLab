// adv-4-grid.mjs - КВАНТОВАНИЕ РАЗМЕРА: что на самом деле стоит за словом «ноционал $2500».
import { loadScan, makeEnv, sideOf, walk } from "./pf-walk.mjs";
import { loadCapacity, q, $ } from "./pf-lib.mjs";
import { costAtSize } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";
const scan = loadScan(process.env.FA_PF_SCAN);
const base = makeEnv();
const cap = loadCapacity();
const STARTS = []; for (let i = 0; i < 8; i++) STARTS.push(720 + i * 60);
const LEN = 7573, YM = 8760 / LEN;
const stat = (capital, env = base) => {
  const nets = [], sizes = [];
  for (const f of STARTS) {
    const r = walk({ scan, env, capital, cadence: 24, kmax: 1, mode: "rule-1", first: f, last: f + LEN });
    nets.push(r.net * YM);
    for (const l of r.log) if (l.act === "set") sizes.push(l.usd);
  }
  return { med: q(nets, 0.5), worst: Math.min(...nets), smed: q(sizes, 0.5), smax: Math.max(...sizes) };
};
console.log("капитал | нетто/год | худш | медиана факт.размера | макс факт.размер | простой капитала");
for (const c of [1995, 2100, 2300, 2500, 2511, 2515, 2600, 3000, 3162, 3200, 4000, 5000]) {
  const s = stat(c);
  console.log(String(c).padStart(6), $(s.med).padStart(9), $(s.worst).padStart(9), $(s.smed).padStart(9), $(s.smax).padStart(9),
    ((1 - s.smax / c) * 100).toFixed(1) + "%", "дох. на заявл.", ((s.med / c) * 100).toFixed(1) + "%");
}
// издержки без замены плоского удара GMX измеренной кривой
const noCurve = { ...base, costOn: (t, cfg, s) => costAtSize({ sizeUsd: s, costs: DEFAULT_COSTS, impact: { gmxNodes: [], hlNodes: cap.impactFor(t, sideOf(cfg)).hlNodes } }) };
console.log("\nбез замены плоских 0.1% удара GMX измеренной кривой:", JSON.stringify(stat(2500, noCurve)));
console.log("база при тех же 8 стартах:", JSON.stringify(stat(2500)));
