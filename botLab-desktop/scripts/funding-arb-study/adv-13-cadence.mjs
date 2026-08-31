// adv-13-cadence.mjs - каданс подбирался на тех же данных? Развёртка по кадансу и по k.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { q, $ } from "./pf-lib.mjs";
const scan = loadScan(process.env.FA_PF_SCAN);
const env = makeEnv();
const STARTS = []; for (let i = 0; i < 8; i++) STARTS.push(720 + i * 24);
const LEN = 7573, YM = 8760 / LEN;
const run = (cad, kmax, mode) => {
  const nets = [], op = [];
  for (const f of STARTS) { const r = walk({ scan, env, capital: 2500, cadence: cad, kmax, mode, first: f, last: f + LEN }); nets.push(r.net * YM); op.push(r.tally.open); }
  return { med: q(nets, 0.5), min: Math.min(...nets), op: q(op, 0.5) };
};
console.log("каданс | rule-1 | худш | кругов");
for (const cad of [4, 8, 12, 24, 48, 72, 168]) { const s = run(cad, 1, "rule-1"); console.log(String(cad).padStart(6), $(s.med).padStart(9), $(s.min).padStart(9), s.op); }
console.log("\nk (число позиций, тот же депозит $5000 -> $2500 на ногу суммарно) | rule-pf | hold-pf");
for (const k of [1, 2, 3, 5]) { const a = run(24, k, "rule-pf"), b = run(24, k, "hold-pf"); console.log("k =", k, "rule-pf", $(a.med).padStart(9), "худш", $(a.min).padStart(9), " hold-pf", $(b.med).padStart(9), "худш", $(b.min).padStart(9)); }
