// В19. Потолок на консервативном керри: где ноциональ упирается в стакан спота и сколько
// это даёт в долларах и в избытке над 4%.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const snaps = JSON.parse(fs.readFileSync(`${SP}/bas-v-deep.json`, "utf8"));
const drawJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-drawup.json`, "utf8"));
const { pairs } = JSON.parse(fs.readFileSync(`${SP}/bas-v-pairs.json`, "utf8"));
const Pm = new Map(pairs.map((p) => [p.perp, p]));
const RF = 0.04, LTV = { HYPE: 0.65, BTC: 0.5 };
const APR = { HYPE: 0.091, BTC: 0.044, ETH: 0.052, XMR: 0.257, PUMP: 0.092 }; // консервативные из В18
const MM = (t) => 1 / (2 * Pm.get(t).maxLev);
const HOLD_D = { 1: 365, 4: 91, 12: 30, 26: 14 };
function ladder(b, s) { const isBid = s === 0, out = []; let e = null;
  for (const sf of ["null", "4", "3", "2"]) { const L = b[sf]?.levels?.[s]; if (!L?.length) continue;
    for (const l of L) { const px = +l.px; if (e !== null && (isBid ? px >= e : px <= e)) continue; out.push({ px, sz: +l.sz }); } if (L.at(-1)) e = +L.at(-1).px; }
  return out.sort((x, y) => (isBid ? y.px - x.px : x.px - y.px)); }
const mid = (b) => { const x = b.null?.levels?.[0]?.[0], y = b.null?.levels?.[1]?.[0]; return x && y ? (+x.px + +y.px) / 2 : NaN; };
function walk(l, m, S, isBid) { if (!isBid) { let r = S, u = 0; for (const x of l) { const n = x.px * x.sz, t = Math.min(r, n); u += t / x.px; r -= t; if (r <= 1e-9) break; } return r > 1e-9 ? null : ((S / u) - m) / m * 1e4; }
  let r = S / m, p = 0; for (const x of l) { const t = Math.min(r, x.sz); p += t * x.px; r -= t; if (r <= 1e-12) break; } return r > 1e-12 ? null : (m - p / (S / m)) / m * 1e4; }
const med = (a) => { const v = a.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y); return v.length >= Math.ceil(a.length / 2) ? v[Math.floor(v.length / 2)] : null; };
const legs = (t, S) => snaps.map((sn) => { const sb = sn.books[`${t}|spot`], pb = sn.books[`${t}|perp`]; if (!sb || !pb) return null;
  const ms = mid(sb), mp = mid(pb); if (!(ms > 0) || !(mp > 0)) return null;
  const sBuy = walk(ladder(sb, 1), ms, S, false), sSell = walk(ladder(sb, 0), ms, S, true);
  const pSell = walk(ladder(pb, 0), mp, S, true), pBuy = walk(ladder(pb, 1), mp, S, false);
  return { sBuy, sSell, pSell, pBuy }; });
const slipAt = (t, S) => { const L = legs(t, S); const sp = med(L.map((x) => x && x.sBuy !== null && x.sSell !== null ? x.sBuy + x.sSell : null));
  const pp = med(L.map((x) => x && x.pSell !== null && x.pBuy !== null ? x.pSell + x.pBuy : null));
  return sp === null || pp === null ? null : { spot: sp, perp: pp, all: sp + pp }; };
const capPM = (t, k) => { const mm = MM(t), xT = 1 + drawJ[t].byHold[HOLD_D[k]].p95, w = 0.5 + 0.5 * LTV[t];
  return 1 + Math.max(0, (mm * xT) / 0.95 - w * xT - 1 + xT); };

console.log("ГДЕ ИМЕННО КОНСТРУКЦИЯ УПИРАЕТСЯ. Разложение проскальзывания круга на ноги, бп:");
console.log("ноциональ".padStart(11) + "  HYPE спот  HYPE перп |  BTC спот   BTC перп |  ETH спот   ETH перп");
for (const S of [100e3, 500e3, 1e6, 2e6, 5e6, 10e6, 15e6, 20e6]) {
  const c = ["HYPE", "BTC", "ETH"].map((t) => slipAt(t, S));
  console.log(`$${(S / 1e6).toFixed(2)}M`.padStart(11) + "  " + c.map((x) => x === null ? "  ПОТОЛОК          " : `${x.spot.toFixed(1).padStart(9)}${x.perp.toFixed(1).padStart(11)} |`).join(""));
}
console.log("\nвидно: перповая нога дешёвая всюду, ПОТОЛОК ЗАДАЁТ СПОТ.\n");

const GRID = []; for (let x = 50e3; x <= 40e6; x *= 1.06) GRID.push(Math.round(x));
console.log("ДОХОД И ИЗБЫТОК ПО НОЦИНАЛЮ, портфельная маржа, консервативное керри:");
for (const t of ["HYPE", "BTC"]) {
  console.log(`\n${t} (керри ${(APR[t] * 100).toFixed(1)}%):`);
  console.log("  k   ноциональ пика  издержки  доход/год   избыток   на капитал | предел стакана | ноциональ где избыток = 0");
  for (const k of [1, 4, 12, 26]) {
    const cm = capPM(t, k); let best = null, maxN = 0, zero = null;
    for (const N of GRID) { const sl = slipAt(t, N); if (sl === null) continue; maxN = N;
      const c = 23 + sl.all, d = N * (APR[t] - k * c * 1e-4), cap = N * cm, ex = d - RF * cap;
      if (!best || ex > best.ex) best = { N, c, d, cap, ex };
      if (best && ex < 0 && zero === null && N > best.N) zero = N; }
    console.log(`  ${String(k).padStart(2)}  ` + (best ? `$${(best.N / 1e6).toFixed(2)}M`.padStart(13) + `${best.c.toFixed(0)} бп`.padStart(10) + `$${Math.round(best.d / 1e3)}k`.padStart(11) + `$${Math.round(best.ex / 1e3)}k`.padStart(10) + `${(best.d / best.cap * 100).toFixed(2)}%`.padStart(12) : "нет") +
      ` | $${(maxN / 1e6).toFixed(1)}M`.padStart(17) + ` | ${zero ? "$" + (zero / 1e6).toFixed(1) + "M" : "не пересекает"}`);
  }
}
