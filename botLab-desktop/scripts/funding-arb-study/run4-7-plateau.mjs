// Где действительно кончается рост: сетка продлена до $100M, ширина портфеля снята (K=25).
import { run } from "./run4-grid.mjs";
const f = (x) => (x < 0 ? "-$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");
const G = [100000, 300000, 1000000, 3000000, 10000000, 30000000, 100000000];
const cap = (c) => c >= 1e6 ? `$${c/1e6}M` : `$${c/1000}k`;
for (const [lbl, o] of [
  ["БАЗА (100% своб. ликв. GMX, пик<=10)", {}],
  ["СРЕДНЕ (50%)", { margin: 2 }],
  ["КОНСЕРВАТИВНО (20%, сырой стакан, 25-й проц., пик<=5)", { margin: 5, hlVariant: "raw", gmxAdverse: true, sane: 5 }],
  ["ПРЕДЕЛЬНО (10%, сырой стакан, 25-й проц., пик<=5)", { margin: 10, hlVariant: "raw", gmxAdverse: true, sane: 5 }],
]) {
  console.log(`\n## ${lbl}`);
  console.log("| капитал | K=8 $/год | K=25 $/год | K=25 загрузка | K=25 размещено $/период |");
  console.log("|---|---|---|---|---|");
  for (const c of G) { const a = run({ capital: c, ...o }); const b = run({ capital: c, K: 25, N: 10, ...o });
    console.log(`| ${cap(c)} | ${f(a.usd)} | ${f(b.usd)} | ${(100*b.util).toFixed(1)}% | ${f(b.util*c)} |`); }
}
