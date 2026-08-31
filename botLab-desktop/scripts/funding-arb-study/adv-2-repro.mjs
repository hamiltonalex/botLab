// adv-2-repro.mjs - воспроизведение головных чисел и АУДИТ ВЫБРАННЫХ РАЗМЕРОВ. READ-ONLY.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { q, $ } from "./pf-lib.mjs";

const SCAN = process.env.FA_PF_SCAN;
const scan = loadScan(SCAN);
const env = makeEnv();
console.log("YEAR", env.YEAR, "часов в скане", scan.size);

const CAP = 2500, CAD = 24;
const STARTS = [];
for (let i = 0; i < 40; i++) STARTS.push(720 + i * 12);
const LEN = 7573; // как в отчёте

const YEARMUL = 8760 / LEN;
const run = (mode, first) => walk({ scan, env, capital: CAP, cadence: CAD, kmax: 1, mode, first, last: first + LEN });

for (const mode of ["rule-1", "hold-1"]) {
  const nets = [], sizes = [], rounds = [];
  for (const f of STARTS) {
    const r = run(mode, f);
    nets.push(r.net);
    rounds.push(r.tally.open);
    for (const l of r.log) if (l.act === "set") sizes.push(l.usd);
  }
  const yr = nets.map((x) => x * YEARMUL);
  console.log(mode, "нетто/год медиана", $(q(yr,0.5)), "худш", $(Math.min(...yr)), "лучш", $(Math.max(...yr)),
    "в плюсе", nets.filter((x)=>x>0).length + "/40", "кругов медиана", q(rounds,0.5));
  console.log("   размеры: n", sizes.length, "min", $(Math.min(...sizes)), "p10", $(q(sizes,0.1)), "медиана", $(q(sizes,0.5)), "max", $(Math.max(...sizes)),
    "доля < $1000", (sizes.filter((s)=>s<1000).length/sizes.length*100).toFixed(1)+"%",
    "доля = потолок 2500", (sizes.filter((s)=>s>2499.99).length/sizes.length*100).toFixed(1)+"%");
}
