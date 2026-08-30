import { run, GRID } from "./run4-grid.mjs";
import { pc, HLI, costRound, costFlat, hlRtBps, gmxRtBps, med, CAP } from "./run4-lib.mjs";
const f = (x) => (x < 0 ? "-$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");
const cap = (c) => c >= 1e6 ? `$${c/1e6}M` : `$${c/1000}k`;
const TOK = Object.keys(HLI.tokens);

console.log("## Что теперь стоит круг: НОВАЯ модель против ПЛОСКОЙ, медиана по 63 именам, бп ноционала");
console.log("| размер | плоская: всего | новая: всего | в т.ч. impact GMX (+ = GMX платит) | в т.ч. слиппедж HL | новая/плоская |");
console.log("|---|---|---|---|---|---|");
for (const S of [1000, 10000, 50000, 100000, 500000, 1000000]) {
  const fl = 1e4 * costFlat(S).total / S;
  const tot = [], gi = [], hs = [];
  for (const t of TOK) { const c = costRound(t, "A", S, { hlVariant: "correctedSqrt" });
    tot.push(1e4*c.total/S); gi.push(c.gmxBps); hs.push(1e4*c.hlSlipUsd/S); }
  console.log(`| ${f(S)} | ${fl.toFixed(1)} | ${med(tot).toFixed(1)} | ${med(gi) >= 0 ? "+" : ""}${med(gi).toFixed(2)} | ${med(hs).toFixed(1)} | ${(med(tot)/fl).toFixed(2)}x |`);
}

console.log("\n## Устойчивость 1: сколько свободной ликвидности GMX бот забирает (в econ-режиме это ГЛАВНЫЙ потолок)");
console.log("| капитал | 100% своб. ликв. | 50% | 20% | 10% |");
console.log("|---|---|---|---|---|");
for (const c of GRID) {
  const r = [1, 2, 5, 10].map((m) => run({ capital: c, margin: m }));
  console.log(`| ${cap(c)} | ${f(r[0].usd)} | ${f(r[1].usd)} | ${f(r[2].usd)} | ${f(r[3].usd)} |`);
}

console.log("\n## Устойчивость 2: вариант стакана HL (снимок сегодняшний, период прошлый)");
console.log("| капитал | сырой стакан (пессимизм) | корневая поправка (база) | линейная поправка (оптимизм) |");
console.log("|---|---|---|---|");
for (const c of GRID) {
  const r = ["raw", "correctedSqrt", "correctedLinear"].map((v) => run({ capital: c, hlVariant: v }));
  console.log(`| ${cap(c)} | ${f(r[0].usd)} | ${f(r[1].usd)} | ${f(r[2].usd)} |`);
}

console.log("\n## Устойчивость 3: пессимистичная кривая GMX (25-й процентиль вместо медианы)");
console.log("| капитал | медиана impact | 25-й процентиль impact |");
console.log("|---|---|---|");
for (const c of GRID) console.log(`| ${cap(c)} | ${f(run({capital:c}).usd)} | ${f(run({capital:c,gmxAdverse:true}).usd)} |`);

console.log("\n## Устойчивость 4: причинный фильтр вменяемости ставки и ширина портфеля");
for (const sane of [5, 10, 30]) {
  console.log(`\n### пик |net APR| в обучающем окне <= ${sane} (${sane*100}% годовых)`);
  console.log("| капитал | K=8 | K=15 | K=25 |");
  console.log("|---|---|---|---|");
  for (const c of GRID) {
    const r = [8, 15, 25].map((K) => run({ capital: c, sane, K }));
    console.log(`| ${cap(c)} | ${f(r[0].usd)} | ${f(r[1].usd)} | ${f(r[2].usd)} |`);
  }
}

console.log("\n## Устойчивость 5: концентрация (N = максимум капитала на одно имя)");
console.log("| капитал | N=3 (до 33%) | N=5 (до 20%) | N=10 (до 10%) |");
console.log("|---|---|---|---|");
for (const c of GRID) { const r = [3,5,10].map((N)=>run({capital:c,N,K:Math.max(8,N)}));
  console.log(`| ${cap(c)} | ${f(r[0].usd)} | ${f(r[1].usd)} | ${f(r[2].usd)} |`); }

console.log("\n## Пункт 4: вклад ПОЛОЖИТЕЛЬНОГО impact GMX в доход");
console.log("| капитал | чистый $/год | impact GMX $/год (+ = доход) | доля в чистом |");
console.log("|---|---|---|---|");
for (const c of GRID) { const r = run({ capital: c });
  console.log(`| ${cap(c)} | ${f(r.usd)} | ${f(-r.gmxImpUsd)} | ${(100*(-r.gmxImpUsd)/r.usd).toFixed(2)}% |`); }
