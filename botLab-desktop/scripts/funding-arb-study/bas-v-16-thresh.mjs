// В16. Порог заказчика. Сколько капитала нужно, чтобы конструкция дала $25-30 тыс,
// и отдельно - чтобы она дала $25-30 тыс СВЕРХ коротких госбумаг под 4%.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const snaps = JSON.parse(fs.readFileSync(`${SP}/bas-v-deep.json`, "utf8"));
const carryJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-carry.json`, "utf8"));
const oosJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-oos-carry.json`, "utf8"));
const drawJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-drawup.json`, "utf8"));
const { pairs } = JSON.parse(fs.readFileSync(`${SP}/bas-v-pairs.json`, "utf8"));
const Pm = new Map(pairs.map((p) => [p.perp, p]));
const RF = 0.04, LTV = { HYPE: 0.65, BTC: 0.5 };
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
const slipAt = (t, S) => med(snaps.map((sn) => { const sb = sn.books[`${t}|spot`], pb = sn.books[`${t}|perp`]; if (!sb || !pb) return null;
  const ms = mid(sb), mp = mid(pb); if (!(ms > 0) || !(mp > 0)) return null;
  const a = [walk(ladder(sb, 1), ms, S, false), walk(ladder(sb, 0), ms, S, true), walk(ladder(pb, 0), mp, S, true), walk(ladder(pb, 1), mp, S, false)];
  return a.some((x) => x === null) ? null : a.reduce((s, x) => s + x, 0); }));
const capMult = (t, k) => { const mm = MM(t), xT = 1 + drawJ[t].byHold[HOLD_D[k]].p95, w = 0.5 + 0.5 * LTV[t];
  const b = Math.max(0, (mm * xT) / 0.95 - w * xT - 1 + xT); return { mult: 1 + b, xLiq: (0.95 * (1 + b)) / (mm + 0.95 * (1 - w)) }; };

console.log("ПОРОГ ЗАКАЗЧИКА, портфельная маржа, ноги HYPE и BTC (только они годятся в залог).");
console.log("исполнение ТЕЙКЕРОМ (23 бп круг) и МЕЙКЕРОМ (11 бп круг, проскальзывание нулевое, но исполнение не гарантировано)\n");
for (const [feeRt, slipMult, label] of [[23, 1, "тейкер: комиссия 23 бп + полное проскальзывание"], [11, 0, "мейкер: комиссия 11 бп, проскальзывания нет"]]) {
  console.log(`--- ${label} ---`);
  console.log("монета".padEnd(7) + "k".padStart(3) + "  керри   ноциональ".padStart(22) + "издержки".padStart(10) + "капитал".padStart(11) + "доход/год".padStart(11) + "избыток".padStart(10) + "  ликвидация при росте");
  for (const t of ["HYPE", "BTC"]) for (const k of [1, 4, 12, 26]) {
    const CONS = { HYPE: 0.091, BTC: 0.044 };
    const apr = (process.argv[2] === "cons" ? CONS[t] : carryJ.res[t].full.apr), cm = capMult(t, k);
    // капитал, при котором ИЗБЫТОК = $27.5k (середина порога)
    const GRID = []; for (let x = 20e3; x <= 40e6; x *= 1.05) GRID.push(Math.round(x));
    let hit = null, bestEx = null;
    for (const N of GRID) { const sl = slipAt(t, N); if (sl === null) continue;
      const c = feeRt + slipMult * sl, d = N * (apr - k * c * 1e-4), cap = N * cm.mult, ex = d - RF * cap;
      if (!bestEx || ex > bestEx.ex) bestEx = { N, c, d, cap, ex };
      if (!hit && ex >= 27500) hit = { N, c, d, cap, ex }; }
    const f = (r) => r ? `$${(r.N / 1e6).toFixed(2)}M`.padStart(11) + `${r.c.toFixed(0)} бп`.padStart(10) + `$${(r.cap / 1e6).toFixed(2)}M`.padStart(11) + `$${Math.round(r.d / 1e3)}k`.padStart(11) + `$${Math.round(r.ex / 1e3)}k`.padStart(10) : "  порог не берётся".padStart(53);
    console.log(t.padEnd(7) + String(k).padStart(3) + `${(apr * 100).toFixed(1)}%`.padStart(8) + f(hit) + `   +${((cm.xLiq - 1) * 100).toFixed(0)}%`);
    if (!hit && bestEx) console.log(`        максимум избытка: ноциональ $${(bestEx.N / 1e6).toFixed(2)}M, капитал $${(bestEx.cap / 1e6).toFixed(2)}M, избыток $${Math.round(bestEx.ex / 1e3)}k`);
  }
  console.log();
}
