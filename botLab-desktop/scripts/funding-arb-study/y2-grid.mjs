import { APP as STUDY_APP, CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
const SP=STUDY_DATA, APP=STUDY_APP;
const CACHE=STUDY_CACHE;
import fs from "node:fs"; import path from "node:path";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { scanTwoLeg } from "../../src/engine/math.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";
import { openPosition, accrueFromRows, closePosition, positionSummary } from "../../src/engine/paper.js";

const MAJORS = ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC","BCH","DOT","ATOM","ARB","OP","NEAR","SUI","TRX","UNI","AAVE","XLM","TAO","FIL"];
const H1 = 24;

// Два периода. Y2 = докачанный 2023-09..2025-06 (ВНЕ выборки, на нём ничего не подбиралось).
// Y1 = имеющийся кэш 2025-06..2026-06, тот самый, на котором получены +29.78%.
const y2 = new Map(), y1 = new Map();
for (const t of MAJORS) {
  const p2 = `${SP}/y2/${t}.csv`;
  if (fs.existsSync(p2)) { const r = parseSpreadCsv(fs.readFileSync(p2, "utf8")); if (r.length) y2.set(t, r); }
  const f = fs.readdirSync(CACHE).find((x) => x.startsWith(`${t}_`));
  if (f) { const r = parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8")); if (r.length === 8761) y1.set(t, r); }
}

console.log(`# ПОКРЫТИЕ ВТОРОГО ПЕРИОДА\n`);
console.log(`| токен | строк Y2 | с | по | лет |`);
console.log(`|---|---|---|---|---|`);
for (const t of MAJORS) {
  const r = y2.get(t);
  if (!r) { console.log(`| ${t} | нет | - | - | - |`); continue; }
  console.log(`| ${t} | ${r.length} | ${r[0].ts.slice(0,10)} | ${r[r.length-1].ts.slice(0,10)} | ${(r.length/8760).toFixed(2)} |`);
}

// Прогон вне выборки, та же реализация, что и на первом периоде.
function walk({ rowsBy, tokens, W, H, N, key = "median", capital = 2000 }) {
  const trainH = W * H1, holdH = H * H1, per = capital / N;
  const rt = roundTripCost(DEFAULT_COSTS, per, false);
  const len = Math.min(...tokens.map((t) => rowsBy.get(t).length));
  let gross = 0, opens = 0, periods = 0, lastEnd = trainH, held = new Set();
  const byPeriod = [], byToken = new Map();
  for (let i = trainH; i + 24 <= len; i += holdH) {
    const te = Math.min(len, i + holdH); if (te - i < 24) break;
    const cand = [];
    for (const t of tokens) {
      const rows = rowsBy.get(t); if (rows.length < len) continue;
      const sc = scanTwoLeg(rows.slice(i - trainH, i), { token: t }); if (!sc) continue;
      const b = sc.chosen === "A" ? sc.A : sc.B;
      const v = key === "median" ? b.netMedian : b.netMean;
      if (Number.isFinite(v) && v > 0) cand.push({ t, cfg: sc.chosen, v });
    }
    cand.sort((x, y) => y.v - x.v);
    const sel = cand.slice(0, N);
    let pg = 0, po = 0;
    for (const s of sel) {
      const rr = rowsBy.get(s.t).slice(i, te);
      const t0 = rr[0].tsHour * 1000, t1 = rr[rr.length-1].tsHour * 1000 + 3600000;
      const p = openPosition({ strategy: "two", instrumentKey: s.t, config: s.cfg, capital: per, leverage: 1, nowMs: t0, roundTripCost: 0 });
      accrueFromRows(p, rr, t1); closePosition(p, t1);
      const g = positionSummary(p).grossPnl;
      gross += g; pg += g; byToken.set(s.t, (byToken.get(s.t) || 0) + g);
      if (!held.has(s.t + s.cfg)) { opens++; po++; }
    }
    held = new Set(sel.map((s) => s.t + s.cfg));
    byPeriod.push(pg - po * rt); periods++; lastEnd = te;
  }
  const yrs = (lastEnd - trainH) / 8760, net = gross - opens * rt;
  return { periods, gross, net, apr: net / capital / yrs, pos: byPeriod.filter((x) => x > 0).length, byToken, yrs };
}
const pc = (x) => (x >= 0 ? "+" : "") + (100 * x).toFixed(2) + "%";

// Общая длина у всех имён периода: берём только тех, у кого история покрывает весь отрезок.
function alignedUniverse(map, minRows) {
  return MAJORS.filter((t) => map.has(t) && map.get(t).length >= minRows);
}

console.log(`\n\n# РЕШАЮЩИЙ ТЕСТ: та же сетка на ВТОРОМ периоде (2023-09..2025-06)\n`);
for (const minRows of [15000, 12000, 8760]) {
  const uni = alignedUniverse(y2, minRows);
  if (uni.length < 4) { console.log(`порог ${minRows} ч: имён ${uni.length}, мало`); continue; }
  const trimmed = new Map(uni.map((t) => [t, y2.get(t).slice(-minRows)]));
  console.log(`## порог истории ${minRows} ч (${(minRows/8760).toFixed(2)} г), имён ${uni.length}: ${uni.join(", ")}`);
  console.log(`| W | H | N | APR | плюсовых | брутто $ |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const W of [30, 90]) for (const H of [30, 90]) for (const N of [1, 3]) {
    const r = walk({ rowsBy: trimmed, tokens: uni, W, H, N, key: "median" });
    console.log(`| ${W} | ${H} | ${N} | ${pc(r.apr)} | ${r.pos}/${r.periods} | ${r.gross.toFixed(2)} |`);
  }
  console.log("");
}

console.log(`\n# КОНТРОЛЬ: та же вселенная на ПЕРВОМ периоде (2025-06..2026-06)\n`);
const uniBoth = alignedUniverse(y2, 12000).filter((t) => y1.has(t));
console.log(`имён в обоих периодах: ${uniBoth.length} (${uniBoth.join(", ")})`);
console.log(`| W | H | N | APR период 1 | плюсовых |`);
console.log(`|---|---|---|---|---|`);
for (const W of [30, 90]) for (const H of [30, 90]) for (const N of [1, 3]) {
  const r = walk({ rowsBy: y1, tokens: uniBoth, W, H, N, key: "median" });
  console.log(`| ${W} | ${H} | ${N} | ${pc(r.apr)} | ${r.pos}/${r.periods} |`);
}
