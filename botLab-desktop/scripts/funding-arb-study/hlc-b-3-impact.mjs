// Б3. Единственный путь, которым НАШ размер может двинуть ставку HL: марк -> импакт-цена -> премия.
import { SP } from "./skept-cap-lib.mjs";
import fs from "node:fs";
const imp = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const snap = JSON.parse(fs.readFileSync(`${SP}/hl.json`, "utf8"));
const uni = snap[0].universe, ctx = snap[1];
const ctxBy = new Map(); uni.forEach((u, i) => ctxBy.set(u.name, ctx[i]));
const XS = imp.meta.xs, BL = imp.meta.bpsLevels;

// --- 3.1 Импакт-ноционал HL: обращаем НАШУ кривую VWAP на ИХ theirBuyBps/theirSellBps ---
// c(X) = односторонняя стоимость в бп от mid для ноционала X (raw.buy.bps / raw.sell.bps)
function invVwap(bps, side) { // какой X даёт стоимость bps
  const y = side.bps;
  if (bps <= y[0]) return XS[0] * (bps / Math.max(y[0], 1e-9)); // линейно вниз
  for (let i = 1; i < XS.length; i++) if (bps <= y[i]) {
    const f = (bps - y[i-1]) / Math.max(y[i] - y[i-1], 1e-12);
    return XS[i-1] * Math.pow(XS[i]/XS[i-1], f);
  }
  return NaN;
}
const inFit = [];
for (const [t, o] of Object.entries(imp.tokens)) {
  const r = o.impactRef; if (!r) continue;
  for (const [th, sd] of [[r.theirBuyBps, o.raw.buy], [r.theirSellBps, o.raw.sell]]) {
    if (!Number.isFinite(th)) continue;
    const flat = sd.bps[0] === sd.bps[sd.bps.length - 1]; // кривая плоская: X не определяется
    const x = invVwap(th, sd);
    if (!flat && Number.isFinite(x) && x > 0) inFit.push({ t, th, x });
  }
}
inFit.sort((a, b) => a.x - b.x);
const med = (a) => a.length ? [...a].sort((x,y)=>x-y)[Math.floor(a.length/2)] : NaN;
const INs = inFit.map(r => r.x);
console.log(`3.1 ИМПАКТ-НОЦИОНАЛ HL (обращение их impactPxs через наш стакан), n=${INs.length} наблюдений:`);
console.log(`    p25 $${Math.round(med(INs.slice(0,Math.floor(INs.length/2))))}  медиана $${Math.round(med(INs))}  p75 $${Math.round(med(INs.slice(Math.floor(INs.length/2))))}`);
const IN = 20000; // берём консервативно крупный: чем БОЛЬШЕ IN, тем МЕНЬШЕ наш относительный сдвиг
const IN_SMALL = 6000;
console.log(`    в расчёте ниже: IN = $${IN_SMALL} (оценка предыдущего замера) и IN = $${IN} (декларация HL); больший IN даёт МЕНЬШИЙ сдвиг, меньший - больший`);

// --- 3.2 Лестница глубины: b(X) = на сколько бп уходит КРАЙ книги, съев X ---
// строим из ntlAtBps (настоящие уровни цены), степенной подгонкой b = a*X^k
function ladder(sd) {
  const pts = BL.map(b => [sd.ntlAtBps[String(b)], b]).filter(p => p[0] > 0);
  if (pts.length < 2) return null;
  let sx=0, sy=0, sxx=0, sxy=0;
  for (const [x, b] of pts) { const lx = Math.log(x), ly = Math.log(b); sx+=lx; sy+=ly; sxx+=lx*lx; sxy+=lx*ly; }
  const n = pts.length, k = (n*sxy - sx*sy)/(n*sxx - sx*sx), la = (sy - k*sx)/n;
  return { a: Math.exp(la), k, pts, cap: sd.visibleNtl, ex: sd.exhaustedFrom };
}
const bOf = (L, X) => L.a * Math.pow(X, L.k);

// --- 3.3 Топ-20 по обороту периода ---
const toks = Object.entries(imp.tokens)
  .map(([t, o]) => ({ t, o, vol: o.volume?.medPeriodNtl || 0 }))
  .sort((a, b) => b.vol - a.vol).slice(0, 20);

const SIZES = [10e3, 50e3, 100e3, 500e3, 1e6, 5e6];
const out = {};
console.log(`\n3.2/3.3 СДВИГ КРАЯ КНИГИ Δ (бп), который наш вход S навязывает импакт-цене (IN=$${IN_SMALL}):`);
console.log(`токен      оборот/сут    видимая      ` + SIZES.map(s => (s>=1e6?`${s/1e6}M`:`${s/1e3}k`).padStart(8)).join(""));
for (const { t, o, vol } of toks) {
  const L = ladder(o.raw.sell); if (!L) continue;
  const base = bOf(L, IN_SMALL);
  const row = SIZES.map(S => {
    if (S > L.cap) return null;               // не помещается в видимый стакан
    return bOf(L, S + IN_SMALL) - base;
  });
  out[t] = { vol, visible: L.cap, k: L.k, a: L.a, base, dBps: row,
             dBpsIN20: SIZES.map(S => S > L.cap ? null : bOf(L, S + IN) - bOf(L, IN)) };
  console.log(`${t.padEnd(9)} $${(vol/1e6).toFixed(0).padStart(6)}M  $${(L.cap/1e6).toFixed(1).padStart(7)}M  ` +
    row.map(v => (v === null ? "  ПОТОЛОК" : v.toFixed(2).padStart(8))).join(""));
}
fs.writeFileSync(`${SP}/hlc-b-impact.json`, JSON.stringify({ IN_SMALL, IN, SIZES, out }, null, 1));
console.log(`\nΔ - это сдвиг ПРЕМИИ в бп (премия = (импакт-цена - оракул)/оракул).`);
console.log(`Ставка меняется на Δ/8 (только вне полосы клампа), т.е. dRate = -Δ*1e-4/8 в час.`);
