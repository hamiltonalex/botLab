// В18. Сводка. Три оценки керри (год кэша / вне выборки / скользящие 6 месяцев), настоящие
// издержки обеих ног, настоящий капитал, избыток над 4%. Всё керри посчитано движком.
import fs from "node:fs";
import { all, openPosition, accrueFromRows, closePosition, SP } from "./skept-cap-lib.mjs";
const snaps = JSON.parse(fs.readFileSync(`${SP}/bas-v-deep.json`, "utf8"));
const oosRaw = JSON.parse(fs.readFileSync(`${SP}/bas-v-oos.json`, "utf8"));
const carryJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-carry.json`, "utf8"));
const oosJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-oos-carry.json`, "utf8"));
const drawJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-drawup.json`, "utf8"));
const basisJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-basis.json`, "utf8"));
const { pairs } = JSON.parse(fs.readFileSync(`${SP}/bas-v-pairs.json`, "utf8"));
const Pm = new Map(pairs.map((p) => [p.perp, p]));
const RF = 0.04, LTV = { HYPE: 0.65, BTC: 0.5 };
const MM = (t) => 1 / (2 * Pm.get(t).maxLev);
const HOLD_D = { 1: 365, 4: 91, 12: 30, 26: 14 };
const N0 = 100000;
const carryRows = (rows) => { const t0 = rows[0].tsHour * 1000, tN = rows.at(-1).tsHour * 1000 + 3600000;
  const p = openPosition({ strategy: "two", instrumentKey: "x", config: "B", capital: N0, leverage: 1, nowMs: t0, roundTripCost: 0 });
  accrueFromRows(p, rows, tN); closePosition(p, tN);
  const hl = p.accruals.reduce((a, x) => a + x.dPnlHl, 0), h = p.accruals.reduce((a, x) => a + x.hlSettlements, 0);
  return h ? (hl / N0) * (8760 / h) : null; };
// скользящие 6 месяцев = последние 4380 часов сшитого ряда
function trailing6(t) {
  const a = (all.get(t) || []).map((r) => ({ tsHour: r.tsHour, f_long: 0, f_short: 0, b_long: 0, b_short: 0, hl_rate: r.hl_rate }));
  const b = (oosRaw[t] || []).map((x) => ({ tsHour: Math.floor(x.time / 1000 / 3600) * 3600, f_long: 0, f_short: 0, b_long: 0, b_short: 0, hl_rate: Number(x.fundingRate) }));
  const m = new Map(); for (const r of [...a, ...b]) if (Number.isFinite(r.hl_rate)) m.set(r.tsHour, r);
  const s = [...m.values()].sort((x, y) => x.tsHour - y.tsHour).slice(-4380);
  return s.length > 100 ? carryRows(s) : null;
}
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
const capPM = (t, k) => { const mm = MM(t), xT = 1 + drawJ[t].byHold[HOLD_D[k]].p95, w = 0.5 + 0.5 * LTV[t];
  const b = Math.max(0, (mm * xT) / 0.95 - w * xT - 1 + xT); return { mult: 1 + b, xLiq: (0.95 * (1 + b)) / (mm + 0.95 * (1 - w)) }; };
const capSTD = (t, k) => { const mm = MM(t), xT = 1 + drawJ[t].byHold[HOLD_D[k]].p95; return { mult: xT * (1 + mm), xLiq: xT }; };

const COINS = ["HYPE", "BTC", "ETH", "SOL", "XMR", "PUMP", "ZEC"];
const APR = {};
console.log("ТРИ ОЦЕНКИ КЕРРИ, все посчитаны движком (конфиг B, сумма dPnlHl), % годовых:");
console.log("монета".padEnd(8) + "год кэша".padStart(10) + "вне выборки".padStart(13) + "скольз. 6 мес".padStart(15) + "   берём в расчёт (минимум из трёх)");
for (const t of COINS) { const a = carryJ.res[t]?.full?.apr, b = oosJ[t]?.apr, c = trailing6(t);
  const use = Math.min(...[a, b, c].filter((x) => x !== null && x !== undefined));
  APR[t] = { a, b, c, use };
  console.log(t.padEnd(8) + (a * 100).toFixed(1).padStart(9) + "%" + (b * 100).toFixed(1).padStart(12) + "%" + (c === null ? "  -" : (c * 100).toFixed(1)).padStart(14) + "%" + (use * 100).toFixed(1).padStart(12) + "%"); }

console.log("\nБАЗИС СПОТ-ПЕРП (риск, не издержка: вход и выход по разному базису), бп, 5000 часов:");
console.log("монета".padEnd(8) + "средний".padStart(9) + "сигма".padStart(8) + "   круг ±1σ по двум точкам");
for (const t of COINS) { const s = basisJ[t]?.stat; if (!s) continue;
  console.log(t.padEnd(8) + s.mean.toFixed(1).padStart(9) + s.sd.toFixed(1).padStart(8) + `   ±${(s.sd * Math.SQRT2).toFixed(1)} бп`); }

const SZ = [10e3, 50e3, 100e3, 500e3, 1e6];
for (const [mode, capf, label] of [["pm", capPM, "ПОРТФЕЛЬНАЯ МАРЖА (спот в залог: только HYPE и BTC, ltv 0.65 и 0.50 из API)"],
                                    ["std", capSTD, "ОБЫЧНЫЙ СЧЁТ (спот залогом не служит; так работают все остальные монеты)"]]) {
  console.log(`\n${"=".repeat(104)}\n${label}`);
  console.log("керри взято консервативное (минимум из трёх оценок). Проценты - ГОДОВЫХ НА КАПИТАЛ, в скобках избыток над 4%.");
  console.log("монета".padEnd(7) + "k".padStart(3) + "капитал/ноц".padStart(12) + "  " + SZ.map((s) => (s >= 1e6 ? `$${s / 1e6}M` : `$${s / 1e3}k`).padStart(16)).join(""));
  for (const t of COINS) {
    if (mode === "pm" && !(t in LTV)) continue;
    for (const k of [1, 4, 12, 26]) {
      const cm = capf(t, k), apr = APR[t].use;
      const cells = SZ.map((S) => { const sl = slipAt(t, S); if (sl === null) return "ПОТОЛОК".padStart(16);
        const c = 23 + sl, d = apr - k * c * 1e-4, roc = d / cm.mult;
        return `${(roc * 100).toFixed(1)}% (${(roc - RF >= 0 ? "+" : "") + ((roc - RF) * 100).toFixed(1)})`.padStart(16); });
      console.log(t.padEnd(7) + String(k).padStart(3) + cm.mult.toFixed(2).padStart(12) + "  " + cells.join(""));
    }
  }
}
