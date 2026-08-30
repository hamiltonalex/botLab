// Устойчивость итога во времени и худший разумный угол зрения.
import { TAB, CAP, YRS, costRound, hlCapUsd, PER } from "./run4-lib.mjs";
import { run, GRID, caps } from "./run4-grid.mjs";
const f = (x) => (x < 0 ? "-$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");

function byPeriod({ capital, N = 3, K = 8, sane = 10, margin = 1, hlVariant = "correctedSqrt", gmxAdverse = false }) {
  const out = []; let held = new Map();
  for (const m of TAB) {
    const cand = [...m.entries()].filter(([, d]) => Number.isFinite(d.peak) && d.peak <= sane)
      .map(([t, d]) => ({ t, ...d })).sort((a, b) => b.v - a.v);
    let left = capital, g = 0, c = 0; const now = new Map(); const tops = [];
    for (const s of cand) {
      if (now.size >= K || left <= 1) break;
      const o = { hlVariant, gmxAdverse, margin, hlTrail: s.hlTrail };
      const hi = Math.min(caps(s.t, s.cfg, o), capital / N, left);
      if (!(hi > 10)) continue;
      let best = 0, bv = 0;
      for (let k = 0; k <= 160; k++) { const S = 10 * Math.pow(hi/10, k/160); if (S > hi) break;
        const v = s.g1*S - costRound(s.t, s.cfg, S, o).total; if (v > bv) { bv = v; best = S; } }
      if (!(best > 0)) continue;
      now.set(s.t + s.cfg, best); left -= best; g += s.g1*best; tops.push([s.t, best, s.g1*best]);
      const prev = held.get(s.t + s.cfg);
      if (!(prev && Math.abs(prev-best)/best < 1e-9)) c += costRound(s.t, s.cfg, best, o).total;
    }
    held = now;
    tops.sort((a,b)=>b[2]-a[2]);
    out.push({ net: g - c, dep: capital - left, top: tops.slice(0,3).map(x=>`${x[0]} ${f(x[1])}/${f(x[2])}`).join(", ") });
  }
  return out;
}
for (const capital of [300000, 1000000]) {
  const p = byPeriod({ capital });
  const tot = p.reduce((a,b)=>a+b.net,0);
  console.log(`\n## помесячно, капитал ${f(capital)} (база: 100% своб. ликв. GMX, K=8, N=3, пик<=10)`);
  console.log("| период | размещено | чистый за 30 дней | 3 главных вклада (размер/чистый) |");
  console.log("|---|---|---|---|");
  p.forEach((r,i)=>console.log(`| ${i+1} | ${f(r.dep)} | ${f(r.net)} | ${r.top} |`));
  const sorted = p.map(r=>r.net).sort((a,b)=>b-a);
  console.log(`  итог ${f(tot)} за ${YRS.toFixed(2)} года = ${f(tot/YRS)}/год; положительных периодов ${p.filter(r=>r.net>0).length}/${p.length}`);
  console.log(`  БЕЗ лучшего периода: ${f((tot - sorted[0])/YRS)}/год; без двух лучших: ${f((tot - sorted[0] - sorted[1])/YRS)}/год`);
  console.log(`  доля лучшего периода в итоге: ${(100*sorted[0]/tot).toFixed(0)}%`);
}

console.log("\n## Худший разумный угол: 10% своб. ликв. GMX + сырой стакан + 25-й процентиль impact + пик<=5");
console.log("| капитал | $/год | APR | загрузка | имён |");
console.log("|---|---|---|---|---|");
for (const c of GRID) { const r = run({ capital: c, margin: 10, hlVariant: "raw", gmxAdverse: true, sane: 5 });
  console.log(`| ${c>=1e6?`$${c/1e6}M`:`$${c/1000}k`} | ${f(r.usd)} | ${(100*r.apr).toFixed(1)}% | ${(100*r.util).toFixed(0)}% | ${r.names} |`); }

console.log("\n## Тот же худший угол, помесячно на плато");
const p = byPeriod({ capital: 1000000, margin: 10, hlVariant: "raw", gmxAdverse: true, sane: 5 });
const tot = p.reduce((a,b)=>a+b.net,0); const s = p.map(r=>r.net).sort((a,b)=>b-a);
console.log(`  ${f(tot/YRS)}/год, положительных ${p.filter(r=>r.net>0).length}/${p.length}, без лучшего периода ${f((tot-s[0])/YRS)}/год, доля лучшего ${(100*s[0]/tot).toFixed(0)}%`);
