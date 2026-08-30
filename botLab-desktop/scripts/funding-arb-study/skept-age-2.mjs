import { loadY1, listingMap, walk, pc, MAJORS, YEAR } from "./skept-age-lib.mjs";
const all = loadY1(); const L = listingMap();
const full = MAJORS.filter((t) => all.get(t)?.length === YEAR);
const CUT = "2024-06-01";
const grp = (u) => ({ old: u.filter((t) => L.dateOf(t) < CUT), neu: u.filter((t) => L.dateOf(t) >= CUT) });

function report(tag, uni) {
  const { old, neu } = grp(uni);
  const b = walk({ rowsBy: all, tokens: uni, W: 90, H: 30, N: 3, key: "median" });
  const gO = old.reduce((s, t) => s + (b.byToken.get(t) ?? 0), 0);
  const gN = neu.reduce((s, t) => s + (b.byToken.get(t) ?? 0), 0);
  const ro = old.length >= 3 ? walk({ rowsBy: all, tokens: old, W: 90, H: 30, N: 3, key: "median" }) : null;
  const rn = neu.length >= 3 ? walk({ rowsBy: all, tokens: neu, W: 90, H: 30, N: 3, key: "median" }) : null;
  console.log(`| ${tag} | ${uni.length} | ${pc(b.apr)} | ${b.pos}/${b.periods} | ${b.gross.toFixed(2)} | ${(100*gN/b.gross).toFixed(1)}% | ${ro?pc(ro.apr):"-"} ${ro?ro.pos+"/"+ro.periods:""} | ${rn?pc(rn.apr):"-"} ${rn?rn.pos+"/"+rn.periods:""} |`);
  return { b, ro, rn, gO, gN };
}
console.log(`# УДАЛЕНИЕ ИМЁН (граница ${CUT}, W=90 H=30 N=3)\n`);
console.log(`| вселенная | имён | APR всех | плюс | брутто | доля новых | APR старых | APR новых |`);
console.log(`|---|---|---|---|---|---|---|---|`);
report("все 23", full);
report("без FIL", full.filter((t) => t !== "FIL"));
report("без FIL,OP", full.filter((t) => !["FIL","OP"].includes(t)));
report("без FIL,OP,TRX", full.filter((t) => !["FIL","OP","TRX"].includes(t)));

console.log(`\n\n# ВЫБИВАНИЕ ПО ОДНОМУ (jackknife) на всей вселенной`);
console.log(`| убран | APR | плюс | брутто | доля новых |`);
console.log(`|---|---|---|---|---|`);
const rows = [];
for (const t of full) {
  const u = full.filter((x) => x !== t);
  const b = walk({ rowsBy: all, tokens: u, W: 90, H: 30, N: 3, key: "median" });
  const { neu } = grp(u);
  const gN = neu.reduce((s, x) => s + (b.byToken.get(x) ?? 0), 0);
  rows.push({ t, apr: b.apr, pos: b.pos, per: b.periods, g: b.gross, share: gN / b.gross });
}
rows.sort((a, b) => a.apr - b.apr);
for (const r of rows) console.log(`| ${r.t} | ${pc(r.apr)} | ${r.pos}/${r.per} | ${r.g.toFixed(2)} | ${(100*r.share).toFixed(1)}% |`);

console.log(`\n\n# ПОПЕРИОДНАЯ РАЗБИВКА: кто и сколько дал (все 23)`);
const b = walk({ rowsBy: all, tokens: full, W: 90, H: 30, N: 3, key: "median" });
for (let p = 0; p < b.periods; p++) {
  const ps = b.picks.filter((x) => x.period === p);
  console.log(`  период ${String(p).padStart(2)}: ${ps.map((x) => `${x.t}/${x.cfg} ${x.g>=0?"+":""}${x.g.toFixed(2)}`).join("  ")}   | итого нетто ${b.byPeriod[p].toFixed(2)}`);
}
console.log(`\n# ТОТ ЖЕ РАСКЛАД БЕЗ FIL`);
const b2 = walk({ rowsBy: all, tokens: full.filter((t)=>t!=="FIL"), W: 90, H: 30, N: 3, key: "median" });
for (let p = 0; p < b2.periods; p++) {
  const ps = b2.picks.filter((x) => x.period === p);
  console.log(`  период ${String(p).padStart(2)}: ${ps.map((x) => `${x.t}/${x.cfg} ${x.g>=0?"+":""}${x.g.toFixed(2)}`).join("  ")}   | итого нетто ${b2.byPeriod[p].toFixed(2)}`);
}
