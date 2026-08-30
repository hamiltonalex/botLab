// Скептик 2. Вогнутость/унимодальность Net(S) на ПЛОТНОЙ сетке (241 узел, шаг 10^0.025).
import fs from "node:fs";
import { MK, TOKS, applyDilution, grossParts, costEmp, costFlat, scanTwoLeg, $, SP } from "./opt-size-lib.mjs";
const cap63 = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((c) => [c.t, c]));
const HL = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const roomOf = (t, cfg) => { const c = cap63.get(t), h = HL.tokens[t];
  const g = c ? (cfg === "A" ? c.availShort : c.availLong) : 0;
  const hl = h ? Math.min(h.raw.buy.visibleNtl, h.raw.sell.visibleNtl) : 0;
  return Math.max(10, Math.min(g, hl)); };
const DENSE = []; for (let e = 1; e <= 7.0001; e += 0.025) DENSE.push(10 ** e);
const COST = process.argv[2] === "flat" ? costFlat : costEmp;
const out = [];
for (const t of TOKS) {
  const m = MK.get(t);
  const sc = scanTwoLeg(m.rows, { token: t }); if (!sc) continue;
  const cfg = sc.chosen, lim = roomOf(t, cfg);
  const ys = DENSE.map((S) => { applyDilution(m, cfg, S, 0, 8761, "pot"); return grossParts(m, cfg, S, 0, 8761).g - COST(t, cfg, S); });
  // локальные максимумы на ВСЕЙ сетке и в зоне ниже потолка
  const peaks = [], peaksCap = [];
  for (let i = 1; i < ys.length - 1; i++) {
    if (ys[i] > ys[i-1] && ys[i] >= ys[i+1]) { peaks.push(i); if (DENSE[i] <= lim) peaksCap.push(i); }
  }
  let bi = 0; for (let i = 1; i < ys.length; i++) if (DENSE[i] <= lim && ys[i] > ys[bi]) bi = i;
  // вторые разности (знак кривизны) в лог-масштабе
  let convexRuns = 0;
  for (let i = 1; i < ys.length - 1; i++) if (ys[i+1] - 2*ys[i] + ys[i-1] > 1e-9 * Math.max(1, Math.abs(ys[i]))) convexRuns++;
  out.push({ t, cfg, lim, peaks: peaks.length, peaksCap: peaksCap.length, sStar: DENSE[bi], vStar: ys[bi],
             convexRuns, atCeil: DENSE[bi] >= lim * 0.98, sPeaks: peaks.map((i) => Math.round(DENSE[i])) });
}
const multi = out.filter((o) => o.peaks > 1), multiCap = out.filter((o) => o.peaksCap > 1);
console.log(`издержки: ${process.argv[2] === "flat" ? "плоские DEFAULT_COSTS" : "эмпирические"}; рынков ${out.length}, узлов ${DENSE.length}`);
console.log(`рынков с >1 локальным максимумом на всей сетке: ${multi.length}`);
console.log(`рынков с >1 локальным максимумом НИЖЕ потолка места: ${multiCap.length}`);
for (const o of multi.slice(0, 15)) console.log(`  ${o.t}/${o.cfg} пиков ${o.peaks} на $${o.sPeaks.join(", $")} | S* $${Math.round(o.sStar)} потолок $${Math.round(o.lim)}`);
const conv = out.filter((o) => o.convexRuns > 0);
console.log(`рынков с выпуклыми участками (вторая разность >0): ${conv.length}, медиана числа таких узлов ${conv.length ? conv.map(o=>o.convexRuns).sort((a,b)=>a-b)[conv.length>>1] : 0}`);
console.log(`S* упирается в потолок места: ${out.filter((o) => o.atCeil).length} рынков`);
fs.writeFileSync(`${SP}/opt-skept-2.json`, JSON.stringify(out));
