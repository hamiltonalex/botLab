import { loadUniverse, loadCapacity, sliceAt, H } from "./pf-lib.mjs";
import { sizeUniverse, allocateCapital, FA_SIZING_DEFAULTS } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";
const { markets } = loadUniverse();
const cap = loadCapacity();
console.log("| час | k=1 нетто | портфель нетто | рынков | прирост |");
console.log("|---|---|---|---|---|");
let w=0,l=0,sum1=0,sumP=0;
for (const t of [800, 1500, 2500, 3500, 4500, 5500, 6500, 7500, 8500]) {
  const slice = sliceAt(markets, t, cap);
  if (!slice.length) continue;
  const u = sizeUniverse({ markets: slice, costs: DEFAULT_COSTS, capitalTotal: 1e9, cfg: FA_SIZING_DEFAULTS });
  const ok = u.curves.filter((c) => !c.refusal);
  if (!ok.length) { console.log(`| ${t} | нет годных | | | |`); continue; }
  // k=1: лучший по нетто, тот же выбор, что делал замер правила выхода
  const best = ok.reduce((a, b) => (b.netUsd > a.netUsd ? b : a));
  // портфель: тот же распределитель, но капитал связывает
  const pf = allocateCapital(ok, 5000, FA_SIZING_DEFAULTS);
  const d = pf.netTotal - best.netUsd;
  if (d>0) w++; else l++;
  sum1 += best.netUsd; sumP += pf.netTotal;
  console.log(`| ${t} | $${best.netUsd.toFixed(2)} (${best.token} $${best.sizeUsd.toFixed(0)}) | $${pf.netTotal.toFixed(2)} | ${pf.alloc.size} | ${d>=0?"+":""}$${d.toFixed(2)} |`);
}
console.log(`\nпортфель выше в ${w} срезах из ${w+l}; сумма по срезам: k=1 $${sum1.toFixed(2)}, портфель $${sumP.toFixed(2)}, отношение ${(sumP/sum1).toFixed(2)}x`);
console.log("ОГОВОРКА: это ОЖИДАНИЕ распределителя на трейлинге, а не реализованный исход. Реализованный даст ходок.");
