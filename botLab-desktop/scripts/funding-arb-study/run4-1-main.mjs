import { run, GRID } from "./run4-grid.mjs";
import { pc } from "./run4-lib.mjs";
const f = (x) => "$" + Math.round(x).toLocaleString("en-US");
const cap = (c) => c >= 1e6 ? `$${c/1e6}M` : `$${c/1000}k`;

console.log("# ПРОГОН 4. Сетка капитала на НАСТОЯЩЕМ влиянии на цену обеих ног");
console.log("# База: стакан HL с корневой поправкой глубины, кривая GMX postClose (нынешний режим),");
console.log("#       экономический размер позиции (argmax чистого результата), фильтр вменяемости пик<=10, K=8, N=3.\n");
for (const [lbl, o] of [
  ["ЭКОНОМИЧЕСКИЙ РАЗМЕР (потолок = стакан HL и свободная ликвидность GMX)", { mode: "econ" }],
  ["ПРЕЖНЕЕ ПРАВИЛО РАЗМЕРА (1% оборота HL, запас 5x) + НОВАЯ издержка", { mode: "rule", share: 0.01, margin: 5 }],
  ["ПРЕЖНЕЕ ПРАВИЛО РАЗМЕРА + ПРЕЖНЯЯ ПЛОСКАЯ ИЗДЕРЖКА (это прогон 3)", { mode: "rule", share: 0.01, margin: 5, flat: true }],
]) {
  console.log(`## ${lbl}`);
  console.log("| капитал | APR | $/год | загрузка | имён | брутто $/год | издержки $/год | в т.ч. impact GMX | в т.ч. слиппедж HL |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const c of GRID) { const r = run({ capital: c, ...o });
    console.log(`| ${cap(c)} | ${pc(r.apr)} | ${f(r.usd)} | ${(100*r.util).toFixed(0)}% | ${r.names} | ${f(r.grossUsd)} | ${f(r.costUsd)} | ${f(r.gmxImpUsd)} | ${f(r.hlSlipUsd)} |`); }
  console.log("");
}
