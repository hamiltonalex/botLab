import { run, GRID } from "./skept4-model-5-grid.mjs";
import { makeCost, covered, pc } from "./skept4-model-5-lib.mjs";
const f=x=>(x<0?"-$":"$")+Math.round(Math.abs(x)).toLocaleString("en-US");
const cap=c=>c>=1e6?`$${c/1e6}M`:`$${c/1000}k`;
console.log("рынков с собственной кривой (>=3 полосы, n>=25):",JSON.stringify(covered));
for(const [lbl,which] of [["ПРОГОН 4: priceImpactUsd","price"],["СКЕПТИК: totalImpactUsd","total"],["ПЛОСКАЯ -10 бп","flat"]]){
  const cf=makeCost(which);
  console.log(`\n## ${lbl}`);
  console.log("| капитал | $/год | загрузка | брутто | издержки | impact GMX | слиппедж HL |");
  console.log("|---|---|---|---|---|---|---|");
  for(const c of GRID){const r=run({capital:c,cf});
    console.log(`| ${cap(c)} | ${f(r.usd)} | ${(100*r.util).toFixed(0)}% | ${f(r.grossUsd)} | ${f(r.costUsd)} | ${f(r.gmxImpUsd)} | ${f(r.hlSlipUsd)} |`);}
}
console.log("\n## жёсткие углы (10% своб. ликв. GMX, сырой стакан, 25-й проц., пик<=5)");
console.log("| капитал | price (прогон 4) | total (скептик) |");
console.log("|---|---|---|");
for(const c of GRID){
  const o={margin:10,hlVariant:"raw",gmxAdverse:true,sane:5};
  const a=run({capital:c,...o,cf:makeCost("price")}), b=run({capital:c,...o,cf:makeCost("total")});
  console.log(`| ${cap(c)} | ${f(a.usd)} | ${f(b.usd)} |`);
}
