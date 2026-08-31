// adv-10-disjoint.mjs - НЕЗАВИСИМЫЕ окна вместо скользящих. Скользящие окна шагом 24 ч
// пересекаются на 97%, поэтому «306 окон» это не 306 наблюдений.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { q, $ } from "./pf-lib.mjs";
const scan = loadScan(process.env.FA_PF_SCAN);
const env = makeEnv();
for (const days of [14, 30, 60, 90]) {
  const len = days * 24;
  const nets = [];
  for (let f = 720; f + len <= 8761; f += len) nets.push(walk({ scan, env, capital: 2500, cadence: 24, kmax: 1, mode: "rule-1", first: f, last: f + len }).net);
  console.log(`окно ${String(days).padStart(3)} сут: НЕПЕРЕСЕКАЮЩИХСЯ окон ${nets.length}, в плюсе ${nets.filter((x) => x > 0).length}/${nets.length}, медиана ${$(q(nets, 0.5))}, худшее ${$(Math.min(...nets))}, лучшее ${$(Math.max(...nets))}`);
}
// то же для hold-1
console.log();
for (const days of [30, 90]) {
  const len = days * 24;
  const nets = [];
  for (let f = 720; f + len <= 8761; f += len) nets.push(walk({ scan, env, capital: 2500, cadence: 24, kmax: 1, mode: "hold-1", first: f, last: f + len }).net);
  console.log(`hold-1 окно ${days} сут: в плюсе ${nets.filter((x) => x > 0).length}/${nets.length}, медиана ${$(q(nets, 0.5))}, худшее ${$(Math.min(...nets))}`);
}
