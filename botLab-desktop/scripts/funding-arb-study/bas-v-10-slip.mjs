// В10. Проскальзывание по НАСТОЯЩИМ стаканам обеих ног. Тонкая книга (20 уровней) сшивается
// с агрегированными (nSigFigs 4 и 3): агрегированные уровни берутся строго ЗА последней ценой
// более тонкой книги, поэтому пересечения нет, а недобор глубины на стыке идёт нам в минус.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const snaps = JSON.parse(fs.readFileSync(`${SP}/bas-v-depth.json`, "utf8"));
const { pairs } = JSON.parse(fs.readFileSync(`${SP}/bas-v-pairs.json`, "utf8"));
export const SIZES = [10e3, 50e3, 100e3, 500e3, 1e6];

// сшивка одной стороны (0=bids, 1=asks) из трёх разрешений
function ladder(books, sideIdx) {
  const isBid = sideIdx === 0;
  const out = [];
  let edge = null; // последняя цена уже взятого куска
  for (const sf of ["null", "4", "3"]) {
    const L = books[sf]?.levels?.[sideIdx]; if (!L?.length) continue;
    for (const l of L) {
      const px = Number(l.px), sz = Number(l.sz);
      if (edge !== null && (isBid ? px >= edge : px <= edge)) continue;
      out.push({ px, sz });
    }
    const last = L.at(-1); if (last) edge = Number(last.px);
  }
  out.sort((a, b) => (isBid ? b.px - a.px : a.px - b.px));
  return out;
}
export function mid(books) {
  const b = books.null?.levels?.[0]?.[0], a = books.null?.levels?.[1]?.[0];
  return b && a ? (Number(b.px) + Number(a.px)) / 2 : NaN;
}
// стоимость в бп от mid для ноциналя S; null если книги не хватает
export function walk(lad, m, S, isBid) {
  // ПОКУПКА: тратим S долларов, считаем сколько единиц получим. ПРОДАЖА: продаём U = S/m единиц,
  // считаем выручку. Обе стороны меряются от середины, знак всегда в минус исполнителю.
  if (!isBid) {
    let rem = S, units = 0;
    for (const l of lad) { const ntl = l.px * l.sz; const take = Math.min(rem, ntl); units += take / l.px; rem -= take; if (rem <= 1e-9) break; }
    if (rem > 1e-9) return null;
    return ((S / units) - m) / m * 1e4;
  }
  let remU = S / m, proceeds = 0;
  for (const l of lad) { const take = Math.min(remU, l.sz); proceeds += take * l.px; remU -= take; if (remU <= 1e-12) break; }
  if (remU > 1e-12) return null;
  const vwap = proceeds / (S / m);
  return (m - vwap) / m * 1e4;
}
const res = {};
for (const p of pairs) {
  const per = { spotBuy: [], spotSell: [], perpSell: [], perpBuy: [], spotVisAsk: [], spotVisBid: [], perpVisBid: [], perpVisAsk: [], mid: [] };
  for (const sn of snaps) {
    const sb = sn.books[`${p.perp}|spot`], pb = sn.books[`${p.perp}|perp`];
    if (!sb || !pb) continue;
    const ms = mid(sb), mp = mid(pb); if (!(ms > 0) || !(mp > 0)) continue;
    const sA = ladder(sb, 1), sB = ladder(sb, 0), pB = ladder(pb, 0), pA = ladder(pb, 1);
    const cap = (l) => l.reduce((a, x) => a + x.px * x.sz, 0);
    per.spotVisAsk.push(cap(sA)); per.spotVisBid.push(cap(sB)); per.perpVisBid.push(cap(pB)); per.perpVisAsk.push(cap(pA));
    per.mid.push(ms);
    per.spotBuy.push(SIZES.map((S) => walk(sA, ms, S, false)));
    per.spotSell.push(SIZES.map((S) => walk(sB, ms, S, true)));
    per.perpSell.push(SIZES.map((S) => walk(pB, mp, S, true)));
    per.perpBuy.push(SIZES.map((S) => walk(pA, mp, S, false)));
  }
  const medArr = (rows, i) => { const v = rows.map((r) => r[i]).filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const medN = (a) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
  res[p.perp] = { wire: p.wire, snaps: per.mid.length,
    spotVisAsk: medN(per.spotVisAsk), spotVisBid: medN(per.spotVisBid), perpVisBid: medN(per.perpVisBid), perpVisAsk: medN(per.perpVisAsk),
    spotBuy: SIZES.map((_, i) => medArr(per.spotBuy, i)), spotSell: SIZES.map((_, i) => medArr(per.spotSell, i)),
    perpSell: SIZES.map((_, i) => medArr(per.perpSell, i)), perpBuy: SIZES.map((_, i) => medArr(per.perpBuy, i)),
    fillSpot: SIZES.map((_, i) => per.spotBuy.filter((r) => r[i] !== null).length / Math.max(per.mid.length, 1)) };
}
fs.writeFileSync(`${SP}/bas-v-slip.json`, JSON.stringify({ SIZES, res }, null, 1));
const F = (x) => (x === null ? "  нет" : x.toFixed(1).padStart(6));
console.log(`ПРОСКАЛЬЗЫВАНИЕ, медиана по ${snaps.length} снимкам, в бп от середины, ОДНА сторона:`);
for (const [k, v] of Object.entries(res)) {
  console.log(`\n${k}  (спот ${v.wire}; видимая книга: спот ask $${(v.spotVisAsk / 1e6).toFixed(2)}M / bid $${(v.spotVisBid / 1e6).toFixed(2)}M, перп bid $${(v.perpVisBid / 1e6).toFixed(2)}M / ask $${(v.perpVisAsk / 1e6).toFixed(2)}M)`);
  console.log("  размер   " + SIZES.map((s) => (s >= 1e6 ? `$${s / 1e6}M` : `$${s / 1e3}k`).padStart(9)).join(""));
  for (const [nm, key] of [["спот покупка", "spotBuy"], ["спот продажа", "spotSell"], ["перп продажа", "perpSell"], ["перп покупка", "perpBuy"]])
    console.log(`  ${nm.padEnd(14)}` + v[key].map((x) => (x === null ? "ПОТОЛОК" : x.toFixed(1)).padStart(9)).join(""));
  const rt = SIZES.map((_, i) => { const a = [v.spotBuy[i], v.spotSell[i], v.perpSell[i], v.perpBuy[i]]; return a.some((x) => x === null) ? null : a.reduce((s, x) => s + x, 0); });
  console.log("  КРУГ обе ноги " + rt.map((x) => (x === null ? "ПОТОЛОК" : x.toFixed(1)).padStart(9)).join(""));
}
