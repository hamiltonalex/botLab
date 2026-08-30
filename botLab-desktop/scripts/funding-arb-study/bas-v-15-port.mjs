// В15. Портфель целиком, ИЗБЫТОК над короткими госбумагами, и доля HYPE.
// Максимизируем не валовые доллары, а ИЗБЫТОК: N*(керри - k*издержки(N)) - 0.04*капитал(N).
// Держать те же деньги в бумагах под 4% - это альтернатива, а не фон.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const snaps = JSON.parse(fs.readFileSync(`${SP}/bas-v-deep.json`, "utf8"));
const carryJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-carry.json`, "utf8"));
const oosJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-oos-carry.json`, "utf8"));
const drawJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-drawup.json`, "utf8"));
const { pairs } = JSON.parse(fs.readFileSync(`${SP}/bas-v-pairs.json`, "utf8"));
const Pm = new Map(pairs.map((p) => [p.perp, p]));
const FEE_RT = 23.0, RF = 0.04;
const LTV = { HYPE: 0.65, BTC: 0.5 };
const MM = (t) => 1 / (2 * Pm.get(t).maxLev);
const HOLD_D = { 1: 365, 4: 91, 12: 30, 26: 14 };
function ladder(b, s) { const isBid = s === 0, out = []; let e = null;
  for (const sf of ["null", "4", "3", "2"]) { const L = b[sf]?.levels?.[s]; if (!L?.length) continue;
    for (const l of L) { const px = +l.px; if (e !== null && (isBid ? px >= e : px <= e)) continue; out.push({ px, sz: +l.sz }); }
    if (L.at(-1)) e = +L.at(-1).px; }
  return out.sort((x, y) => (isBid ? y.px - x.px : x.px - y.px)); }
const mid = (b) => { const x = b.null?.levels?.[0]?.[0], y = b.null?.levels?.[1]?.[0]; return x && y ? (+x.px + +y.px) / 2 : NaN; };
function walk(l, m, S, isBid) { if (!isBid) { let r = S, u = 0; for (const x of l) { const n = x.px * x.sz, t = Math.min(r, n); u += t / x.px; r -= t; if (r <= 1e-9) break; } return r > 1e-9 ? null : ((S / u) - m) / m * 1e4; }
  let r = S / m, p = 0; for (const x of l) { const t = Math.min(r, x.sz); p += t * x.px; r -= t; if (r <= 1e-12) break; } return r > 1e-12 ? null : (m - p / (S / m)) / m * 1e4; }
const med = (a) => { const v = a.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y); return v.length >= Math.ceil(a.length / 2) ? v[Math.floor(v.length / 2)] : null; };
const costAt = (t, S) => med(snaps.map((sn) => { const sb = sn.books[`${t}|spot`], pb = sn.books[`${t}|perp`]; if (!sb || !pb) return null;
  const ms = mid(sb), mp = mid(pb); if (!(ms > 0) || !(mp > 0)) return null;
  const a = [walk(ladder(sb, 1), ms, S, false), walk(ladder(sb, 0), ms, S, true), walk(ladder(pb, 0), mp, S, true), walk(ladder(pb, 1), mp, S, false)];
  return a.some((x) => x === null) ? null : a.reduce((s, x) => s + x, 0) + FEE_RT; }));
function capMult(t, k, pm) { const mm = MM(t), xT = 1 + (drawJ[t]?.byHold[HOLD_D[k]]?.p95 ?? 1);
  if (pm) { if (!(t in LTV)) return null; const w = 0.5 + 0.5 * LTV[t]; const b = Math.max(0, (mm * xT) / 0.95 - w * xT - 1 + xT); return { mult: 1 + b, xLiq: (0.95 * (1 + b)) / (mm + 0.95 * (1 - w)) }; }
  return { mult: xT * (1 + mm), xLiq: xT }; }
const GRID = []; for (let x = 10e3; x <= 60e6; x *= 1.15) GRID.push(Math.round(x));
const COINS = ["HYPE", "BTC", "ETH", "SOL", "ZEC", "XMR", "PUMP"];
const PMOK = new Set(["HYPE", "BTC"]);
function best(t, k, src, capBps) { // capBps: жёсткий предел на издержки круга
  const apr = src === "oos" ? oosJ[t]?.apr : carryJ.res[t]?.full?.apr; if (apr === undefined) return null;
  const pm = PMOK.has(t), cm = capMult(t, k, pm); if (!cm) return null;
  let b = null;
  for (const N of GRID) { const c = costAt(t, N); if (c === null || (capBps && c > capBps)) continue;
    const cap = N * cm.mult, dollars = N * (apr - k * c * 1e-4), ex = dollars - RF * cap;
    if (!b || ex > b.ex) b = { N, c, cap, dollars, ex, roc: dollars / cap, apr, pm, xLiq: cm.xLiq }; }
  return b;
}
for (const capBps of [null, 60]) {
  console.log(`\n${"=".repeat(100)}\nПОРТФЕЛЬ, максимум ИЗБЫТКА над 4% ${capBps ? `при пределе издержек круга ${capBps} бп` : "без предела на издержки"}`);
  for (const src of ["in", "oos"]) {
    console.log(`\nкерри ${src === "in" ? "В ВЫБОРКЕ (год кэша)" : "ВНЕ ВЫБОРКИ (2026-06-20..08-30)"}`);
    for (const k of [1, 4, 12, 26]) {
      const rows = COINS.map((t) => [t, best(t, k, src, capBps)]).filter(([, b]) => b && b.ex > 0);
      if (!rows.length) { console.log(`  ${k}/год: ни одна монета не даёт избытка над 4%`); continue; }
      const tot = rows.reduce((a, [, b]) => ({ cap: a.cap + b.cap, d: a.d + b.dollars, ex: a.ex + b.ex }), { cap: 0, d: 0, ex: 0 });
      const hy = rows.find(([t]) => t === "HYPE")?.[1];
      console.log(`  ${String(k).padStart(2)}/год  капитал $${(tot.cap / 1e6).toFixed(2)}M  доход $${Math.round(tot.d / 1e3)}k  избыток над 4% $${Math.round(tot.ex / 1e3)}k  на капитал ${(tot.d / tot.cap * 100).toFixed(2)}%`);
      console.log(`         состав: ` + rows.map(([t, b]) => `${t} $${(b.N / 1e6).toFixed(2)}M/${Math.round(b.dollars / 1e3)}k`).join("  "));
      console.log(`         доля HYPE в доходе ${hy ? (hy.dollars / tot.d * 100).toFixed(1) : "0.0"}%, в избытке ${hy ? (hy.ex / tot.ex * 100).toFixed(1) : "0.0"}%, в капитале ${hy ? (hy.cap / tot.cap * 100).toFixed(1) : "0.0"}%`);
      const noH = rows.filter(([t]) => t !== "HYPE").reduce((a, [, b]) => ({ cap: a.cap + b.cap, d: a.d + b.dollars, ex: a.ex + b.ex }), { cap: 0, d: 0, ex: 0 });
      console.log(`         БЕЗ HYPE: капитал $${(noH.cap / 1e6).toFixed(2)}M  доход $${Math.round(noH.d / 1e3)}k  избыток $${Math.round(noH.ex / 1e3)}k  на капитал ${noH.cap ? (noH.d / noH.cap * 100).toFixed(2) : "0.00"}%`);
    }
  }
}
