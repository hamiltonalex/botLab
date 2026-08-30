// Что РЕАЛЬНО ограничивает размер: интерьерный оптимум издержки, стакан HL, свободная
// ликвидность GMX или доля капитала. Без этого числа сетки нельзя интерпретировать.
import { TAB, CAP, YRS, costRound, hlCapUsd } from "./run4-lib.mjs";
const o = { hlVariant: "correctedSqrt" };
const f = (x) => "$" + Math.round(x).toLocaleString("en-US");
function bestUnbounded(g1, t, cfg) {           // оптимум БЕЗ всяких потолков
  let best = 0, bv = 0;
  for (let k = 0; k <= 300; k++) { const S = 10 * Math.pow(1e8 / 10, k / 300);
    const v = g1 * S - costRound(t, cfg, S, o).total; if (v > bv) { bv = v; best = S; } }
  return best;
}
for (const capital of [100000, 300000, 1000000, 10000000]) {
  const N = 3, K = 8, sane = 10; const why = new Map(); let dep = 0, per = 0;
  const rows = [];
  for (const m of TAB) {
    const cand = [...m.entries()].filter(([, d]) => Number.isFinite(d.peak) && d.peak <= sane)
      .map(([t, d]) => ({ t, ...d })).sort((a, b) => b.v - a.v);
    let left = capital; let n = 0;
    for (const s of cand) {
      if (n >= K || left <= 1) break;
      const r = CAP.get(s.t); const av = s.cfg === "A" ? r.availShort : r.availLong;
      const hc = hlCapUsd(s.t, o.hlVariant);
      const hi = Math.min(hc, av, capital / N, left);
      const unb = bestUnbounded(s.g1, s.t, s.cfg);
      const size = Math.min(unb, hi);
      if (!(size > 1)) continue;
      const lim = size >= hi * 0.999
        ? (hi === hc ? "стакан HL" : hi === av ? "своб. ликв. GMX" : hi === capital / N ? "доля капитала" : "остаток капитала")
        : "оптимум издержки";
      why.set(lim, (why.get(lim) || 0) + 1); rows.push({ t: s.t, size, lim, unb, hc, av });
      left -= size; dep += size; n++;
    }
    per++;
  }
  console.log(`\n## капитал ${f(capital)}: чем ограничен размер (${rows.length} позиций за ${per} периодов)`);
  for (const [k, v] of [...why].sort((a,b)=>b[1]-a[1])) console.log(`  ${k}: ${v} (${(100*v/rows.length).toFixed(0)}%)`);
  console.log(`  средний размер позиции ${f(dep / rows.length)}, размещено за период в среднем ${f(dep / per)}`);
  const big = rows.slice().sort((a,b)=>b.size-a.size).slice(0,6);
  console.log(`  крупнейшие: ` + big.map(r=>`${r.t} ${f(r.size)} [${r.lim}]`).join(", "));
}
console.log("\n## безусловный оптимум издержки по именам (сколько бы взяли, если б не потолки)");
const seen = new Set(); const out = [];
for (const m of TAB) for (const [t, d] of m) { const k = t + d.cfg; if (seen.has(k)) continue; seen.add(k);
  out.push({ t, cfg: d.cfg, unb: bestUnbounded(d.g1, t, d.cfg), hc: hlCapUsd(t, o.hlVariant),
             av: d.cfg === "A" ? CAP.get(t).availShort : CAP.get(t).availLong }); }
const live = out.filter(r => r.unb > 1).sort((a,b)=>b.unb-a.unb);
console.log(`  имён с положительным оптимумом: ${live.length} из ${out.length}`);
for (const r of live.slice(0, 12)) console.log(`  ${r.t}/${r.cfg}: оптимум ${f(r.unb)}, стакан HL ${f(r.hc)}, своб. ликв. GMX ${f(r.av)}`);
