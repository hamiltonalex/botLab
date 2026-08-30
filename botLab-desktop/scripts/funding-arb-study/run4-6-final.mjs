// Сводная таблица: сетка капитала в трёх режимах доверия + ядро без вырожденных ставок.
import { TAB, CAP, YRS, costRound } from "./run4-lib.mjs";
import { caps, GRID } from "./run4-grid.mjs";
const f = (x) => (x < 0 ? "-$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");
const cap = (c) => c >= 1e6 ? `$${c/1e6}M` : `$${c/1000}k`;

function full({ capital, N = 3, K = 8, sane = 10, margin = 1, hlVariant = "correctedSqrt", gmxAdverse = false }) {
  let held = new Map(); const rows = []; let utilSum = 0; const names = new Set();
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
      const cc = (prev && Math.abs(prev-best)/best < 1e-9) ? null : costRound(s.t, s.cfg, best, o);
      rows.push({ t: s.t, size: best, net: s.g1*best - (cc ? cc.total : 0), realAPR: s.g1*8760/720,
                  gmxImp: cc ? cc.gmxImpactUsd : 0, hlSlip: cc ? cc.hlSlip ?? cc.hlSlipUsd : 0, cost: cc ? cc.total : 0 });
      now.set(s.t + s.cfg, best); left -= best; names.add(s.t);
    }
    held = now; utilSum += (capital - left)/capital;
  }
  const tot = rows.reduce((a,b)=>a+b.net,0);
  const core = rows.filter(r => r.realAPR <= 10).reduce((a,b)=>a+b.net,0);
  const core3 = rows.filter(r => r.realAPR <= 3).reduce((a,b)=>a+b.net,0);
  return { usd: tot/YRS, core: core/YRS, core3: core3/YRS, apr: tot/capital/YRS,
           util: utilSum/TAB.length, names: names.size, pos: rows.length,
           cost: rows.reduce((a,b)=>a+b.cost,0)/YRS, gmxImp: rows.reduce((a,b)=>a+b.gmxImp,0)/YRS,
           hlSlip: rows.reduce((a,b)=>a+b.hlSlip,0)/YRS };
}
const MODES = [
  ["БАЗА: 100% своб. ликв. GMX, стакан с корневой поправкой, медиана impact, пик<=10", {}],
  ["СРЕДНЕ: 50% своб. ликв. GMX, корневая поправка, медиана impact, пик<=10", { margin: 2 }],
  ["КОНСЕРВАТИВНО: 20% своб. ликв. GMX, сырой стакан, 25-й проц. impact, пик<=5", { margin: 5, hlVariant: "raw", gmxAdverse: true, sane: 5 }],
  ["ПРЕДЕЛЬНО: 10% своб. ликв. GMX, сырой стакан, 25-й проц. impact, пик<=5", { margin: 10, hlVariant: "raw", gmxAdverse: true, sane: 5 }],
];
for (const [lbl, o] of MODES) {
  console.log(`\n## ${lbl}`);
  console.log("| капитал | APR | $/год всего | $/год БЕЗ вырожденных (реализ. >1000%) | $/год ЯДРО (реализ. <=300%) | загрузка | имён | издержки $/год |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const c of GRID) { const r = full({ capital: c, ...o });
    console.log(`| ${cap(c)} | ${(100*r.apr).toFixed(1)}% | ${f(r.usd)} | ${f(r.core)} | ${f(r.core3)} | ${(100*r.util).toFixed(0)}% | ${r.names} | ${f(r.cost)} |`); }
}
console.log("\n## ПЛАТО В ДОЛЛАРАХ (максимум по сетке, капитал плато)");
console.log("| режим | плато всего | при капитале | плато без вырожденных | плато ядра |");
console.log("|---|---|---|---|---|");
for (const [lbl, o] of MODES) {
  const rs = GRID.map((c) => ({ c, ...full({ capital: c, ...o }) }));
  const b = rs.reduce((a, x) => x.usd > a.usd ? x : a);
  const bc = rs.reduce((a, x) => x.core > a.core ? x : a);
  const b3 = rs.reduce((a, x) => x.core3 > a.core3 ? x : a);
  console.log(`| ${lbl.split(":")[0]} | ${f(b.usd)} | ${cap(b.c)} | ${f(bc.core)} | ${f(b3.core3)} |`);
}
