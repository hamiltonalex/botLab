import { APP as STUDY_APP, CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs"; import path from "node:path";
const APP = STUDY_APP+"/src/engine";
export const { parseSpreadCsv } = await import(`${APP}/format.js`);
export const M = await import(`${APP}/math.js`);
export const { DEFAULT_COSTS, roundTripCost } = await import(`${APP}/costs.js`);
export const P = await import(`${APP}/paper.js`);
export const CACHE = STUDY_CACHE;
export const SP = STUDY_DATA;
export const YEAR = 8761, H1 = 24;
export const MAJORS = ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC","BCH","DOT","ATOM","ARB","OP","NEAR","SUI","TRX","UNI","AAVE","XLM","HBAR","TAO","FIL"];

export function loadY1() {
  const all = new Map();
  for (const f of fs.readdirSync(CACHE).filter((f) => f.endsWith(".csv") && !f.startsWith("_")))
    all.set(f.replace(/_\d+_\d+\.csv$/, ""), parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8")));
  return all;
}
export function loadY2() {
  const m = new Map();
  for (const f of fs.readdirSync(`${SP}/y2`).filter((f) => f.endsWith(".csv")))
    m.set(f.replace(/\.csv$/, ""), parseSpreadCsv(fs.readFileSync(`${SP}/y2/${f}`, "utf8")));
  return m;
}
export function listingMap() {
  const lines = fs.readFileSync(`${CACHE}/_scan_results.csv`, "utf8").trim().split("\n");
  const ix = Object.fromEntries(lines[0].split(",").map((h, i) => [h, i]));
  const addr = new Map(), gname = new Map();
  for (const l of lines.slice(1)) { const p = l.split(","); addr.set(p[ix.token], (p[ix.gmx_market]||"").toLowerCase()); gname.set(p[ix.token], p[ix.gmx_name]); }
  const listing = new Map();
  for (const f of [`${SP}/mi.json`, `${SP}/mi-avax.json`])
    for (const m of (JSON.parse(fs.readFileSync(f, "utf8")).markets ?? []))
      listing.set(m.marketToken.toLowerCase(), m);
  return { addr, gname, byAddr: listing, dateOf: (t) => (listing.get(addr.get(t))?.listingDate || "").slice(0, 10) };
}

// Прогон вне выборки. Правила зовутся из движка (scanTwoLeg / openPosition / accrueFromRows /
// positionSummary / roundTripCost). Копия walk() из age-test-main.mjs критика, чтобы числа были сравнимы.
export function walk({ rowsBy, tokens, W, H, N, key = "median", capital = 2000, len = null }) {
  const trainH = W * H1, holdH = H * H1, per = capital / N;
  const rt = roundTripCost(DEFAULT_COSTS, per, false);
  const L = len ?? YEAR;
  let gross = 0, opens = 0, periods = 0, lastEnd = trainH, held = new Set();
  const byPeriod = [], byToken = new Map(), picks = [];
  for (let i = trainH; i + 24 <= L; i += holdH) {
    const te = Math.min(L, i + holdH); if (te - i < 24) break;
    const cand = [];
    for (const t of tokens) {
      const rows = rowsBy.get(t); if (!rows || rows.length < L) continue;
      const sc = M.scanTwoLeg(rows.slice(i - trainH, i), { token: t }); if (!sc) continue;
      const b = sc.chosen === "A" ? sc.A : sc.B;
      const v = key === "median" ? b.netMedian : b.netMean;
      if (Number.isFinite(v) && v > 0) cand.push({ t, cfg: sc.chosen, v });
    }
    cand.sort((x, y) => y.v - x.v);
    const sel = cand.slice(0, N);
    let pg = 0, po = 0;
    for (const s of sel) {
      const rr = rowsBy.get(s.t).slice(i, te);
      const t0 = rr[0].tsHour * 1000, t1 = rr[rr.length - 1].tsHour * 1000 + 3600000;
      const p = P.openPosition({ strategy: "two", instrumentKey: s.t, config: s.cfg, capital: per, leverage: 1, nowMs: t0, roundTripCost: 0 });
      P.accrueFromRows(p, rr, t1); P.closePosition(p, t1);
      const g = P.positionSummary(p).grossPnl;
      gross += g; pg += g; byToken.set(s.t, (byToken.get(s.t) || 0) + g);
      picks.push({ period: periods, t: s.t, cfg: s.cfg, g });
      if (!held.has(s.t + s.cfg)) { opens++; po++; }
    }
    held = new Set(sel.map((s) => s.t + s.cfg));
    byPeriod.push(pg - po * rt); periods++; lastEnd = te;
  }
  const yrs = (lastEnd - trainH) / 8760, net = gross - opens * rt;
  return { periods, opens, gross, net, apr: net / capital / yrs, pos: byPeriod.filter((x) => x > 0).length, byToken, byPeriod, picks, yrs };
}
export const pc = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (100 * x).toFixed(2) + "%" : "-");
