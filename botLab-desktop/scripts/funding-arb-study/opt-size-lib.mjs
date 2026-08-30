// Общая часть замера «оптимальный размер по каждому рынку».
// Начисление ВСЕГДА делает движок (openPosition/accrueFromRows/closePosition/positionSummary),
// комиссии круга - roundTripCost() движка. Здесь только: разбавление ставки получателя
// по тождеству GMX и эмпирические кривые удара/проскальзывания.
import fs from "node:fs";
import { oiTokens, loadRows, loadOi, SP, DEFAULT_COSTS, roundTripCost, scanTwoLeg,
         openPosition, accrueFromRows, closePosition, positionSummary } from "./indep-lib.mjs";
export { DEFAULT_COSTS, roundTripCost, scanTwoLeg, SP };
export const HOUR_MS = 3600e3;

// ---------- рынки: полный год + снимки OI ----------
export const MK = new Map();       // t -> { rows, work, f0, pot, bown[cfg], okc }
export const TOKS = [];
for (const t of oiTokens) {
  const rows = loadRows(t); if (!rows || rows.length !== 8761) continue;
  const oi = loadOi(t);
  const n = rows.length;
  const pot = new Float64Array(n), bl = new Float64Array(n), bs = new Float64Array(n);
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const s = oi.get(rows[i].tsHour);
    if (!s || !(s.bl > 0) || !(s.bs > 0)) continue;
    bl[i] = s.bl; bs[i] = s.bs;
    pot[i] = Math.max(Math.abs(rows[i].f_long) * s.bl, Math.abs(rows[i].f_short) * s.bs);
    ok[i] = 1;
  }
  // рабочая копия строк: движок читает её, мы переписываем в ней только ставку СВОЕЙ стороны
  const work = rows.map((r) => ({ ...r }));
  MK.set(t, { rows, work, pot, bl, bs, ok,
              fl: Float64Array.from(rows.map((r) => r.f_long)),
              fs_: Float64Array.from(rows.map((r) => r.f_short)) });
  TOKS.push(t);
}

// Разбавление на отрезке [a,b): ставка ПОЛУЧАТЕЛЯ падает с pot/B до pot/(B+S).
// Часы, где платим МЫ (f<0), не трогаем - они входят полной величиной на наш размер.
// Час без валидных баз: доход обнуляем (издержки ноги остаются) - консервативно.
// mode "flip": если наш вход делает нашу сторону БОЛЬШЕЙ, доход обнуляем.
export function applyDilution(m, cfg, S, a, b, mode = "pot") {
  const short = cfg === "A";
  const src = short ? m.fs_ : m.fl;
  const key = short ? "f_short" : "f_long";
  for (let i = a; i < b; i++) {
    const f = src[i];
    if (!(f > 0)) { m.work[i][key] = f; continue; }
    if (!m.ok[i]) { m.work[i][key] = 0; continue; }
    const bx = short ? m.bs[i] : m.bl[i], bo = short ? m.bl[i] : m.bs[i];
    m.work[i][key] = (mode === "flip" && bx + S > bo) ? 0 : m.pot[i] / (bx + S);
  }
}
export function resetRows(m, cfg, a, b) {
  const short = cfg === "A"; const src = short ? m.fs_ : m.fl; const key = short ? "f_short" : "f_long";
  for (let i = a; i < b; i++) m.work[i][key] = src[i];
}

// Брутто движком на отрезке [a,b) при размере S (издержки круга НЕ включены).
export function grossOf(m, cfg, S, a, b) {
  const w = m.work.slice(a, b);
  const p = openPosition({ strategy: "two", instrumentKey: "x", config: cfg, capital: S, leverage: 1,
                           nowMs: w[0].tsHour * 1000, roundTripCost: 0 });
  const end = w[w.length - 1].tsHour * 1000 + HOUR_MS;
  accrueFromRows(p, w, end); closePosition(p, end);
  return positionSummary(p).grossPnl;
}
// то же, но с разбором на ноги: GMX-фандинг, GMX-borrow, HL-фандинг (журнал движка)
export function grossParts(m, cfg, S, a, b) {
  const w = m.work.slice(a, b);
  const p = openPosition({ strategy: "two", instrumentKey: "x", config: cfg, capital: S, leverage: 1,
                           nowMs: w[0].tsHour * 1000, roundTripCost: 0 });
  const end = w[w.length - 1].tsHour * 1000 + HOUR_MS;
  accrueFromRows(p, w, end); closePosition(p, end);
  let f = 0, bo = 0, h = 0;
  for (const x of p.accruals) { f += x.fundingUsd; bo += x.borrowUsd; h += x.dPnlHl; }
  return { g: positionSummary(p).grossPnl, f, b: bo, h };
}
export function grossAt(m, cfg, S, a, b, mode = "pot") { applyDilution(m, cfg, S, a, b, mode); return grossOf(m, cfg, S, a, b); }

// ---------- издержки ----------
const G = JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`, "utf8"));
const HL = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const XS = HL.meta.xs;
const interp = (xs, ys, x) => {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) { const f = (x - xs[i-1]) / (xs[i] - xs[i-1]); return ys[i-1] + f * (ys[i] - ys[i-1]); }
  return ys[ys.length-1] * Math.pow(x / xs[xs.length-1], 0.64);   // за краем стакана - степенной хвост
};
const NOIMP = { ...DEFAULT_COSTS, gmxImpact: 0 };
export function gmxImpactBps(t, cfg, S) {
  const cur = (G.interp[t] || {})[cfg === "A" ? "short" : "long"] || [];
  if (!cur.length) return 1;
  return Math.abs(interp(cur.map((p) => p.sizeUsd), cur.map((p) => p.adverseBps ?? p.bps ?? 0), S));
}
export function hlSlipBps(t, S) {
  const h = HL.tokens[t]; if (!h) return 10;
  return interp(XS, h.raw.buy.bps, S) + interp(XS, h.raw.sell.bps, S);
}
// «плоская» модель - ровно DEFAULT_COSTS движка (ей получены прежние числа $3162/$9507)
export const costFlat = (t, cfg, S) => roundTripCost(DEFAULT_COSTS, S, false);
// «эмпирическая» - тот же движок без gmxImpact плюс измеренные кривые обеих ног
export const costEmp = (t, cfg, S) =>
  roundTripCost(NOIMP, S, false) + S * gmxImpactBps(t, cfg, S) / 1e4 + S * hlSlipBps(t, S) / 1e4;

// ---------- сетка размеров ----------
export const SIZES = []; for (let e = 1; e <= 7.0001; e += 0.1) SIZES.push(Math.round(10 ** e));

// ---------- золотое сечение по log10(S) ----------
export function golden(f, lo, hi, iters = 30) {
  const R = (Math.sqrt(5) - 1) / 2;
  let a = Math.log10(lo), b = Math.log10(hi);
  let c = b - R * (b - a), d = a + R * (b - a);
  let fc = f(10 ** c), fd = f(10 ** d);
  for (let i = 0; i < iters; i++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - R * (b - a); fc = f(10 ** c); }
    else { a = c; c = d; fc = fd; d = a + R * (b - a); fd = f(10 ** d); }
  }
  const x = 10 ** ((a + b) / 2);
  return { S: x, v: f(x) };
}
export const $ = (x) => (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 });
