import fs from "node:fs";
import { loadY1, listingMap, walk, pc, MAJORS, YEAR, SP } from "./skept-age-lib.mjs";
const all = loadY1(); const L = listingMap();
const full = MAJORS.filter((t) => all.get(t)?.length === YEAR);
const cap = new Map(JSON.parse(fs.readFileSync(`${SP}/capacity.json`, "utf8")).map((r) => [r.t, r]));
const base = walk({ rowsBy: all, tokens: full, W: 90, H: 30, N: 3, key: "median" });
const G = (t) => base.byToken.get(t) ?? 0;
const CUT = "2024-06-01";

function spearman(a, b) { // a,b массивы чисел одинаковой длины
  const rk = (xs) => { const s = xs.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(xs.length);
    for (let i = 0; i < s.length;) { let j = i; while (j + 1 < s.length && s[j+1][0] === s[i][0]) j++; const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[s[k][1]] = avg; i = j + 1; } return r; };
  const ra = rk(a), rb = rk(b), n = a.length;
  const m = (x) => x.reduce((s, v) => s + v, 0) / n;
  const ma = m(ra), mb = m(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i]-ma)*(rb[i]-mb); da += (ra[i]-ma)**2; db += (rb[i]-mb)**2; }
  return num / Math.sqrt(da * db);
}

const rows = full.map((t) => ({ t, d: L.dateOf(t), dts: Date.parse(L.dateOf(t)), avail: cap.get(t).avail, oi: cap.get(t).oi, hlOi: cap.get(t).hlOi, hlVol: cap.get(t).hlVol, g: G(t) }));

console.log(`# СПУТАННОСТЬ ВОЗРАСТА И РАЗМЕРА (23 имени)`);
console.log(`  Спирмен(дата листинга, avail GMX)     = ${spearman(rows.map(r=>r.dts), rows.map(r=>r.avail)).toFixed(3)}`);
console.log(`  Спирмен(дата листинга, OI GMX)        = ${spearman(rows.map(r=>r.dts), rows.map(r=>r.oi)).toFixed(3)}`);
console.log(`  Спирмен(дата листинга, OI HL)         = ${spearman(rows.map(r=>r.dts), rows.map(r=>r.hlOi)).toFixed(3)}`);
console.log(`  Спирмен(дата листинга, оборот HL)     = ${spearman(rows.map(r=>r.dts), rows.map(r=>r.hlVol)).toFixed(3)}`);
console.log(`\n  Спирмен(вклад, дата листинга)         = ${spearman(rows.map(r=>r.g), rows.map(r=>r.dts)).toFixed(3)}`);
console.log(`  Спирмен(вклад, -avail GMX)            = ${spearman(rows.map(r=>r.g), rows.map(r=>-r.avail)).toFixed(3)}`);
console.log(`  Спирмен(вклад, -OI HL)                = ${spearman(rows.map(r=>r.g), rows.map(r=>-r.hlOi)).toFixed(3)}`);

console.log(`\n\n# ТАБЛИЦА: возраст против размера, отсортировано по РАЗМЕРУ (avail GMX)`);
console.log(`| токен | листинг | новый? | avail GMX $ | OI HL $ | вклад $ | слотов |`);
console.log(`|---|---|---|---|---|---|---|`);
for (const r of [...rows].sort((a,b)=>b.avail-a.avail))
  console.log(`| ${r.t} | ${r.d} | ${r.d>=CUT?"НОВЫЙ":"стар"} | ${Math.round(r.avail).toLocaleString("en-US")} | ${Math.round(r.hlOi).toLocaleString("en-US")} | ${r.g.toFixed(2)} | ${base.picks.filter(p=>p.t===r.t).length} |`);

console.log(`\n\n# КОНКУРС ОБЪЯСНЕНИЙ: восемь имён по разным признакам`);
const top8 = (sel) => { const s = sel.slice(0, 8); const g = s.reduce((a, t) => a + G(t), 0);
  return { s, g, share: g / base.gross }; };
const byNew = [...rows].sort((a,b)=>b.dts-a.dts).map(r=>r.t);
const bySmallAvail = [...rows].sort((a,b)=>a.avail-b.avail).map(r=>r.t);
const bySmallHlOi = [...rows].sort((a,b)=>a.hlOi-b.hlOi).map(r=>r.t);
const bySmallHlVol = [...rows].sort((a,b)=>a.hlVol-b.hlVol).map(r=>r.t);
for (const [tag, list] of [["8 САМЫХ НОВЫХ", byNew], ["8 самых МЕЛКИХ по avail GMX", bySmallAvail], ["8 самых МЕЛКИХ по OI HL", bySmallHlOi], ["8 самых МЕЛКИХ по обороту HL", bySmallHlVol]]) {
  const r = top8(list);
  console.log(`  ${tag.padEnd(30)}: ${r.s.join(",").padEnd(42)} брутто $${r.g.toFixed(2).padStart(7)} = ${(100*r.share).toFixed(1)}%`);
}

console.log(`\n\n# КРЕСТ 2x2: возраст (граница ${CUT}) x размер (медиана avail GMX)`);
const med = [...rows].map(r=>r.avail).sort((a,b)=>a-b)[Math.floor(rows.length/2)];
console.log(`  медиана avail = $${Math.round(med).toLocaleString("en-US")}`);
const cell = (isNew, isSmall) => rows.filter((r) => (r.d>=CUT)===isNew && (r.avail<med)===isSmall);
for (const [nm, isNew, isSmall] of [["старые+КРУПНЫЕ",false,false],["старые+мелкие",false,true],["НОВЫЕ+КРУПНЫЕ",true,false],["НОВЫЕ+мелкие",true,true]]) {
  const c = cell(isNew, isSmall);
  const g = c.reduce((s,r)=>s+r.g,0);
  console.log(`  ${nm.padEnd(16)} имён ${String(c.length).padStart(2)}: ${c.map(r=>r.t).join(",").padEnd(46)} брутто $${g.toFixed(2).padStart(7)} = ${(100*g/base.gross).toFixed(1)}%`);
}

console.log(`\n\n# ПРОГОНЫ ПО ГРУППАМ (W=90 H=30 N=3)`);
console.log(`| вселенная | имён | APR | плюс | брутто $ |`);
console.log(`|---|---|---|---|---|`);
const runs = [
  ["8 самых НОВЫХ", byNew.slice(0,8)],
  ["8 самых МЕЛКИХ (avail)", bySmallAvail.slice(0,8)],
  ["15 самых СТАРЫХ", byNew.slice(8)],
  ["15 самых КРУПНЫХ (avail)", bySmallAvail.slice(8)],
  ["старые И мелкие (avail<мед)", cell(false,true).map(r=>r.t)],
  ["новые И мелкие", cell(true,true).map(r=>r.t)],
  ["все мелкие (avail<мед)", rows.filter(r=>r.avail<med).map(r=>r.t)],
  ["все крупные (avail>=мед)", rows.filter(r=>r.avail>=med).map(r=>r.t)],
];
for (const [nm, uni] of runs) {
  if (uni.length < 3) { console.log(`| ${nm} | ${uni.length} | мало имён | - | - |`); continue; }
  const r = walk({ rowsBy: all, tokens: uni, W: 90, H: 30, N: 3, key: "median" });
  console.log(`| ${nm} | ${uni.length} | ${pc(r.apr)} | ${r.pos}/${r.periods} | ${r.gross.toFixed(2)} |`);
}

console.log(`\n\n# ВНУТРИ НОВОЙ ГРУППЫ: что упорядочивает вклад, возраст или размер?`);
const nw = rows.filter(r=>r.d>=CUT);
console.log(`  по ДАТЕ листинга (от старой к новой): ${[...nw].sort((a,b)=>a.dts-b.dts).map(r=>`${r.t}=${r.g.toFixed(0)}`).join("  ")}`);
console.log(`  по РАЗМЕРУ avail (от крупного к мелкому): ${[...nw].sort((a,b)=>b.avail-a.avail).map(r=>`${r.t}=${r.g.toFixed(0)}`).join("  ")}`);
console.log(`  Спирмен внутри новых(вклад, дата)  = ${spearman(nw.map(r=>r.g), nw.map(r=>r.dts)).toFixed(3)}`);
console.log(`  Спирмен внутри новых(вклад,-avail) = ${spearman(nw.map(r=>r.g), nw.map(r=>-r.avail)).toFixed(3)}`);
