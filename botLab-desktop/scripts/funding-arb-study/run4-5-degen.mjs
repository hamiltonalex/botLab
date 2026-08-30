// Сколько итога держится на ВЫРОЖДЕННЫХ ставках. Причинный фильтр смотрит в обучающее окно,
// но платит РЕАЛИЗОВАННАЯ ставка окна удержания. Меряем экспозицию (это диагностика, не правило).
import { TAB, CAP, YRS, costRound, hlCapUsd, med } from "./run4-lib.mjs";
import { caps } from "./run4-grid.mjs";
const f = (x) => (x < 0 ? "-$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");
const o0 = { hlVariant: "correctedSqrt" };

function picks(capital, N = 3, K = 8, sane = 10, margin = 1) {
  const rows = []; let held = new Map();
  for (let pi = 0; pi < TAB.length; pi++) {
    const cand = [...TAB[pi].entries()].filter(([, d]) => Number.isFinite(d.peak) && d.peak <= sane)
      .map(([t, d]) => ({ t, ...d })).sort((a, b) => b.v - a.v);
    let left = capital; const now = new Map();
    for (const s of cand) {
      if (now.size >= K || left <= 1) break;
      const o = { ...o0, margin, hlTrail: s.hlTrail };
      const hi = Math.min(caps(s.t, s.cfg, o), capital / N, left); if (!(hi > 10)) continue;
      let best = 0, bv = 0;
      for (let k = 0; k <= 160; k++) { const S = 10*Math.pow(hi/10, k/160); if (S > hi) break;
        const v = s.g1*S - costRound(s.t, s.cfg, S, o).total; if (v > bv) { bv = v; best = S; } }
      if (!(best > 0)) continue;
      const prev = held.get(s.t + s.cfg);
      const c = (prev && Math.abs(prev-best)/best < 1e-9) ? 0 : costRound(s.t, s.cfg, best, o).total;
      rows.push({ pi, t: s.t, cfg: s.cfg, size: best, net: s.g1*best - c,
                  realAPR: s.g1 * 8760/720, trainPeak: s.peak });
      now.set(s.t + s.cfg, best); left -= best;
    }
    held = now;
  }
  return rows;
}
for (const capital of [300000, 1000000]) {
  const r = picks(capital); const tot = r.reduce((a,b)=>a+b.net,0);
  console.log(`\n## капитал ${f(capital)}: вклад по РЕАЛИЗОВАННОЙ годовой ставке окна удержания`);
  console.log("| реализованный net APR позиции | позиций | вклад в чистый $/год | доля |");
  console.log("|---|---|---|---|");
  const bins = [[10, Infinity, "> 1000%"], [3, 10, "300-1000%"], [1, 3, "100-300%"], [-Infinity, 1, "< 100%"]];
  for (const [lo, hi, lbl] of bins) {
    const g = r.filter(x => x.realAPR > lo && x.realAPR <= hi);
    const s = g.reduce((a,b)=>a+b.net,0);
    console.log(`| ${lbl} | ${g.length} | ${f(s/YRS)} | ${(100*s/tot).toFixed(0)}% |`);
  }
  const top = r.slice().sort((a,b)=>b.net-a.net).slice(0,6);
  console.log("  крупнейшие вклады: " + top.map(x=>`${x.t}/${x.cfg} п.${x.pi+1} размер ${f(x.size)} чистый ${f(x.net)} (реализовано ${(100*x.realAPR).toFixed(0)}% годовых, обуч. пик ${(100*x.trainPeak).toFixed(0)}%)`).join("; "));
  console.log(`  медианный вклад позиции: ${f(med(r.map(x=>x.net)))}, всего позиций ${r.length}`);
  const sane1000 = r.filter(x=>x.realAPR<=10).reduce((a,b)=>a+b.net,0);
  console.log(`  ЕСЛИ ОТРЕЗАТЬ реализованные >1000% годовых: ${f(sane1000/YRS)}/год вместо ${f(tot/YRS)}/год`);
}
