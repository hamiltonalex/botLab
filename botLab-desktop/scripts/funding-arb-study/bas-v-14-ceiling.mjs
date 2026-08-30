// В14. ПОТОЛОК. Доход конструкции = N*(керри - k*издержки(N)); издержки растут с N, поэтому
// функция имеет МАКСИМУМ. Ищем его прямым обходом настоящих стаканов, без подгонки формул.
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

function ladder(books, sideIdx) {
  const isBid = sideIdx === 0; const out = []; let edge = null;
  for (const sf of ["null", "4", "3", "2"]) {
    const L = books[sf]?.levels?.[sideIdx]; if (!L?.length) continue;
    for (const l of L) { const px = Number(l.px), sz = Number(l.sz);
      if (edge !== null && (isBid ? px >= edge : px <= edge)) continue; out.push({ px, sz }); }
    const last = L.at(-1); if (last) edge = Number(last.px);
  }
  out.sort((a, b) => (isBid ? b.px - a.px : a.px - b.px)); return out;
}
const mid = (b) => { const x = b.null?.levels?.[0]?.[0], y = b.null?.levels?.[1]?.[0]; return x && y ? (Number(x.px) + Number(y.px)) / 2 : NaN; };
function walk(lad, m, S, isBid) {
  if (!isBid) { let rem = S, u = 0; for (const l of lad) { const n = l.px * l.sz, t = Math.min(rem, n); u += t / l.px; rem -= t; if (rem <= 1e-9) break; } if (rem > 1e-9) return null; return ((S / u) - m) / m * 1e4; }
  let r = S / m, p = 0; for (const l of lad) { const t = Math.min(r, l.sz); p += t * l.px; r -= t; if (r <= 1e-12) break; } if (r > 1e-12) return null; return (m - p / (S / m)) / m * 1e4;
}
const med = (a) => { const v = a.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y); return v.length >= Math.ceil(a.length / 2) ? v[Math.floor(v.length / 2)] : null; };
function costAt(t, S) { // круг обеих ног в бп: медиана по снимкам
  const per = snaps.map((sn) => {
    const sb = sn.books[`${t}|spot`], pb = sn.books[`${t}|perp`]; if (!sb || !pb) return null;
    const ms = mid(sb), mp = mid(pb); if (!(ms > 0) || !(mp > 0)) return null;
    const a = [walk(ladder(sb, 1), ms, S, false), walk(ladder(sb, 0), ms, S, true), walk(ladder(pb, 0), mp, S, true), walk(ladder(pb, 1), mp, S, false)];
    return a.some((x) => x === null) ? null : a.reduce((s, x) => s + x, 0) + FEE_RT;
  });
  return med(per);
}
function capMult(t, k, pm) {
  const mm = MM(t), xT = 1 + (drawJ[t]?.byHold[HOLD_D[k]]?.p95 ?? 1);
  if (pm) { if (!(t in LTV)) return null; const w = 0.5 + 0.5 * LTV[t];
    const b = Math.max(0, (mm * xT) / 0.95 - w * xT - 1 + xT); return { mult: 1 + b, xLiq: (0.95 * (1 + b)) / (mm + 0.95 * (1 - w)) }; }
  return { mult: 1 + (xT * (1 + mm) - 1), xLiq: xT };
}
const GRID = []; for (let x = 10e3; x <= 60e6; x *= 1.25) GRID.push(Math.round(x));
const COINS = ["HYPE", "BTC", "ETH", "SOL", "ZEC", "XMR", "PUMP"];
const out = {};
console.log(`ПОТОЛОК КОНСТРУКЦИИ, снимков книг ${snaps.length}, издержки = комиссии тейкера ${FEE_RT} бп + проскальзывание обеих ног`);
for (const k of [1, 4, 12]) {
  console.log(`\n--- ${k} перезаход(ов) в год ---`);
  console.log("монета".padEnd(7) + "режим".padEnd(6) + "керри".padStart(7) + "  ноциональ пика".padStart(17) + "издержки там".padStart(13) + "капитал".padStart(12) + "$ в год".padStart(11) + "  на капитал   макс ноциональ где стакан ещё держит");
  for (const t of COINS) {
    const apr = carryJ.res[t]?.full?.apr; if (apr === undefined) continue;
    for (const pm of [false, true]) {
      const cm = capMult(t, k, pm); if (!cm) continue;
      let best = null, maxN = 0;
      for (const N of GRID) { const c = costAt(t, N); if (c === null) continue; maxN = N;
        const netN = apr - k * c * 1e-4; const dollars = N * netN;
        if (!best || dollars > best.dollars) best = { N, c, netN, dollars, cap: N * cm.mult, roc: netN / cm.mult }; }
      if (!best) continue;
      out[`${t}|${k}|${pm ? "pm" : "std"}`] = { ...best, xLiq: cm.xLiq, maxN };
      console.log(t.padEnd(7) + (pm ? "порт" : "обыч").padEnd(6) + (apr * 100).toFixed(1).padStart(6) + "%" +
        ("$" + (best.N / 1e6).toFixed(2) + "M").padStart(17) + (best.c.toFixed(0) + " бп").padStart(13) +
        ("$" + (best.cap / 1e6).toFixed(2) + "M").padStart(12) + ("$" + Math.round(best.dollars / 1e3) + "k").padStart(11) +
        (best.roc * 100).toFixed(1).padStart(9) + "%" + ("$" + (maxN / 1e6).toFixed(1) + "M").padStart(14));
    }
  }
}
fs.writeFileSync(`${SP}/bas-v-ceiling.json`, JSON.stringify(out, null, 1));
