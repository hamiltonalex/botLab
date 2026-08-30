import { loadY1, listingMap, walk, pc, MAJORS, YEAR } from "./skept-age-lib.mjs";
const all = loadY1(); const L = listingMap();
const full = MAJORS.filter((t) => all.get(t)?.length === YEAR);
const base = walk({ rowsBy: all, tokens: full, W: 90, H: 30, N: 3, key: "median" });
console.log(`# БАЗА: APR ${pc(base.apr)} брутто $${base.gross.toFixed(2)} входов ${base.opens} плюс ${base.pos}/${base.periods}`);

const picked = [...new Set(base.picks.map((p) => p.t))];
console.log(`\n# СКОЛЬКО ИМЁН ВООБЩЕ БЫЛО ВЫБРАНО`);
console.log(`  слотов всего ${base.picks.length} (${base.periods} периодов x 3), РАЗНЫХ имён выбрано ${picked.length} из ${full.length}: ${picked.join(", ")}`);
const never = full.filter((t) => !picked.includes(t));
console.log(`  НИ РАЗУ не выбраны (${never.length}): ${never.join(", ")}`);
const byDate = full.map((t) => ({ t, d: L.dateOf(t), g: base.byToken.get(t) ?? 0, n: base.picks.filter((p)=>p.t===t).length })).sort((a,b)=>a.d.localeCompare(b.d));
console.log(`\n| токен | листинг | слотов | брутто $ | доля брутто |`);
console.log(`|---|---|---|---|---|`);
for (const r of byDate) console.log(`| ${r.t} | ${r.d} | ${r.n} | ${r.g.toFixed(2)} | ${(100*r.g/base.gross).toFixed(1)}% |`);

console.log(`\n\n# СВИП ГРАНИЦЫ РАСКОЛА (все возможные даты между листингами)`);
const dates = [...new Set(byDate.map((r) => r.d))].sort();
console.log(`даты листинга в выборке: ${dates.join(", ")}`);
console.log(`\n| граница | старых | новых | брутто старых | брутто новых | доля новых | APR старых | плюс | APR новых | плюс |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|`);
const cuts = dates.slice(1); // граница = "листинг >= дата" -> новые
for (const cut of cuts) {
  const old = byDate.filter((r) => r.d < cut).map((r) => r.t);
  const neu = byDate.filter((r) => r.d >= cut).map((r) => r.t);
  const gO = old.reduce((s, t) => s + (base.byToken.get(t) ?? 0), 0);
  const gN = neu.reduce((s, t) => s + (base.byToken.get(t) ?? 0), 0);
  const ro = old.length >= 3 ? walk({ rowsBy: all, tokens: old, W: 90, H: 30, N: 3, key: "median" }) : null;
  const rn = neu.length >= 3 ? walk({ rowsBy: all, tokens: neu, W: 90, H: 30, N: 3, key: "median" }) : null;
  console.log(`| ${cut} | ${old.length} | ${neu.length} | ${gO.toFixed(2)} | ${gN.toFixed(2)} | ${(100*gN/base.gross).toFixed(1)}% | ${ro?pc(ro.apr):"-"} | ${ro?ro.pos+"/"+ro.periods:"-"} | ${rn?pc(rn.apr):"-"} | ${rn?rn.pos+"/"+rn.periods:"-"} |`);
}
