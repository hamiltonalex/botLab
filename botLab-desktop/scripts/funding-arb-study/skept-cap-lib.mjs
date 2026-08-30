import { APP as STUDY_APP, CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs"; import path from "node:path";
const ENG = STUDY_APP+"/src/engine";
export const { parseSpreadCsv } = await import(`${ENG}/format.js`);
export const { scanTwoLeg, annualizeRow, maxOf, mean, median } = await import(`${ENG}/math.js`);
export const { DEFAULT_COSTS, roundTripCost } = await import(`${ENG}/costs.js`);
export const { openPosition, accrueFromRows, closePosition, positionSummary } = await import(`${ENG}/paper.js`);

export const CACHE = STUDY_CACHE;
export const SP = STUDY_DATA;
export const H1 = 24, YEAR = 8761;

export const all = new Map();
for (const f of fs.readdirSync(CACHE).filter((f) => f.endsWith(".csv") && !f.startsWith("_")))
  all.set(f.replace(/_\d+_\d+\.csv$/, ""), parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8")));

export const MAJORS = ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC","BCH","DOT","ATOM","ARB","OP","NEAR","SUI","TRX","UNI","AAVE","XLM","HBAR","TAO","FIL"];
export const full = MAJORS.filter((t) => all.get(t)?.length === YEAR);

// ТОЧНАЯ копия walk() критика (правила зовутся из движка), плюс журнал выбранных конфигов.
export function walk({ tokens, W, H, N, key = "median", capital = 2000, costMult = 1 }) {
  const trainH = W * H1, holdH = H * H1, per = capital / N;
  const c = Object.fromEntries(Object.entries(DEFAULT_COSTS).map(([k, v]) => [k, v * costMult]));
  const rt = roundTripCost(c, per, false);
  let gross = 0, opens = 0, periods = 0, lastEnd = trainH;
  let held = new Set(); const byPeriod = [], byToken = new Map(), picks = [];
  for (let i = trainH; i + 24 <= YEAR; i += holdH) {
    const te = Math.min(YEAR, i + holdH); if (te - i < 24) break;
    const cand = [];
    for (const t of tokens) {
      const rows = all.get(t); if (!rows || rows.length !== YEAR) continue;
      const train = rows.slice(i - trainH, i);
      const sc = scanTwoLeg(train, { token: t }); if (!sc) continue;
      const b = sc.chosen === "A" ? sc.A : sc.B;
      const v = key === "median" ? b.netMedian : b.netMean;
      if (Number.isFinite(v) && v > 0) cand.push({ t, cfg: sc.chosen, v });
    }
    cand.sort((x, y) => y.v - x.v);
    const sel = cand.slice(0, N);
    let pg = 0, po = 0;
    for (const s of sel) {
      const rows = all.get(s.t).slice(i, te);
      const p = openPosition({ strategy: "two", instrumentKey: s.t, config: s.cfg, capital: per, leverage: 1, nowMs: rows[0].tsHour * 1000, roundTripCost: 0 });
      accrueFromRows(p, rows, rows[rows.length - 1].tsHour * 1000 + 3600000);
      closePosition(p, rows[rows.length - 1].tsHour * 1000 + 3600000);
      const g = positionSummary(p).grossPnl;
      gross += g; pg += g; byToken.set(s.t, (byToken.get(s.t) || 0) + g);
      if (!held.has(s.t + s.cfg)) { opens++; po++; }
      picks.push({ period: periods, t: s.t, cfg: s.cfg, g });
    }
    held = new Set(sel.map((s) => s.t + s.cfg));
    byPeriod.push(pg - po * rt); periods++; lastEnd = te;
  }
  const yrs = (lastEnd - trainH) / 8760;
  const net = gross - opens * rt;
  return { periods, opens, gross, net, rt, yrs, apr: net / capital / yrs, pos: byPeriod.filter((x) => x > 0).length, byToken, picks };
}
export const pc = (x) => (x >= 0 ? "+" : "") + (100 * x).toFixed(2) + "%";
export const capRows = JSON.parse(fs.readFileSync(`${SP}/capacity.json`, "utf8"));
