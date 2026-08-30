// Ядро без вырожденных ставок на широком портфеле и продлённой сетке. Это и есть та часть
// итога, которую не держит горстка окон с трёх-, четырёхзначной годовой ставкой.
import { TAB, YRS, costRound } from "./run4-lib.mjs";
import { caps } from "./run4-grid.mjs";
const f = (x) => (x < 0 ? "-$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");
const cap = (c) => c >= 1e6 ? `$${c/1e6}M` : `$${c/1000}k`;
function full({ capital, N, K, sane, margin, hlVariant, gmxAdverse }) {
  let held = new Map(); const rows = []; let u = 0;
  for (const m of TAB) {
    const cand = [...m.entries()].filter(([, d]) => Number.isFinite(d.peak) && d.peak <= sane)
      .map(([t, d]) => ({ t, ...d })).sort((a, b) => b.v - a.v);
    let left = capital; const now = new Map();
    for (const s of cand) {
      if (now.size >= K || left <= 1) break;
      const o = { hlVariant, gmxAdverse, margin, hlTrail: s.hlTrail };
      const hi = Math.min(caps(s.t, s.cfg, o), capital / N, left); if (!(hi > 10)) continue;
      let best = 0, bv = 0;
      for (let k = 0; k <= 160; k++) { const S = 10*Math.pow(hi/10, k/160); if (S > hi) break;
        const v = s.g1*S - costRound(s.t, s.cfg, S, o).total; if (v > bv) { bv = v; best = S; } }
      if (!(best > 0)) continue;
      const prev = held.get(s.t + s.cfg);
      const c = (prev && Math.abs(prev-best)/best < 1e-9) ? 0 : costRound(s.t, s.cfg, best, o).total;
      rows.push({ net: s.g1*best - c, r: s.g1*8760/720 }); now.set(s.t+s.cfg, best); left -= best;
    }
    held = now; u += (capital-left)/capital;
  }
  const S = (p) => rows.filter(r => p(r)).reduce((a,b)=>a+b.net,0)/YRS;
  return { all: S(()=>true), core: S(r=>r.r<=10), core3: S(r=>r.r<=3), util: u/TAB.length };
}
const G = [100000, 300000, 1000000, 3000000, 10000000, 30000000, 100000000];
for (const [lbl, o] of [
  ["БАЗА, K=25 (100% своб. ликв., корневая поправка, медиана impact, пик<=10)", { N: 10, K: 25, sane: 10, margin: 1, hlVariant: "correctedSqrt", gmxAdverse: false }],
  ["КОНСЕРВАТИВНО, K=25 (20% своб. ликв., сырой стакан, 25-й проц., пик<=5)", { N: 10, K: 25, sane: 5, margin: 5, hlVariant: "raw", gmxAdverse: true }],
  ["ПРЕДЕЛЬНО, K=25 (10% своб. ликв., сырой стакан, 25-й проц., пик<=5)", { N: 10, K: 25, sane: 5, margin: 10, hlVariant: "raw", gmxAdverse: true }],
]) {
  console.log(`\n## ${lbl}`);
  console.log("| капитал | всего $/год | без вырожденных (реализ.>1000%) | ядро (реализ.<=300%) | загрузка |");
  console.log("|---|---|---|---|---|");
  for (const c of G) { const r = full({ capital: c, ...o });
    console.log(`| ${cap(c)} | ${f(r.all)} | ${f(r.core)} | ${f(r.core3)} | ${(100*r.util).toFixed(1)}% |`); }
}
