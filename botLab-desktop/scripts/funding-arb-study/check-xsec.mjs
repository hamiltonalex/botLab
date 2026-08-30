import { CACHE as STUDY_CACHE } from "./paths.mjs";
import fs from "node:fs"; import path from "node:path";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { scanTwoLeg, annualizeRow, maxOf } from "../../src/engine/math.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";
import { openPosition, accrueFromRows, closePosition, positionSummary } from "../../src/engine/paper.js";
const CACHE = STUDY_CACHE;
const H1 = 24, YEAR = 8761;
const all = new Map();
for (const f of fs.readdirSync(CACHE).filter((f) => f.endsWith(".csv") && !f.startsWith("_")))
  all.set(f.replace(/_\d+_\d+\.csv$/, ""), parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8")));

const MAJORS = ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC","BCH","DOT","ATOM","ARB","OP","NEAR","SUI","TRX","UNI","AAVE","XLM","HBAR","TAO","FIL"];
const full = MAJORS.filter((t) => all.get(t)?.length === YEAR);
const partial = MAJORS.filter((t) => all.has(t) && all.get(t).length !== YEAR);
const missing = MAJORS.filter((t) => !all.has(t));
console.log(`# ВЫЖИВАЕМОСТЬ ВСЕЛЕННОЙ`);
console.log(`  всего файлов в кэше: ${all.size}`);
console.log(`  мажоров в списке ${MAJORS.length}: полная история ${full.length}, обрезанная ${partial.length} (${partial.join(",")||"-"}), отсутствуют ${missing.length} (${missing.join(",")||"-"})`);

// Прогон вне выборки. Реализация СВОЯ, но правила зовутся из движка.
function walk({ tokens, W, H, N, key, capital = 2000, costMult = 1, calmTrail = null }) {
  const trainH = W * H1, holdH = H * H1, per = capital / N;
  const c = Object.fromEntries(Object.entries(DEFAULT_COSTS).map(([k, v]) => [k, v * costMult]));
  const rt = roundTripCost(c, per, false);
  let gross = 0, opens = 0, periods = 0, lastEnd = trainH;
  let held = new Set(); const byPeriod = [], byToken = new Map();
  for (let i = trainH; i + 24 <= YEAR; i += holdH) {
    const te = Math.min(YEAR, i + holdH); if (te - i < 24) break;
    const cand = [];
    for (const t of tokens) {
      const rows = all.get(t); if (!rows || rows.length !== YEAR) continue;
      const train = rows.slice(i - trainH, i);
      // «спокойный» фильтр СТРОГО по обучающему окну, без заглядывания в год
      if (calmTrail != null) {
        const pk = maxOf(train.map(annualizeRow).map((a) => Math.max(Math.abs(a.net_A), Math.abs(a.net_B))));
        if (!(pk <= calmTrail)) continue;
      }
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
    }
    held = new Set(sel.map((s) => s.t + s.cfg));
    byPeriod.push(pg - po * rt); periods++; lastEnd = te;
  }
  const yrs = (lastEnd - trainH) / 8760;
  const net = gross - opens * rt;
  return { periods, opens, gross, net, apr: net / capital / yrs, pos: byPeriod.filter((x) => x > 0).length, byToken };
}
const pc = (x) => (x >= 0 ? "+" : "") + (100 * x).toFixed(2) + "%";

console.log(`\n# ВОСПРОИЗВЕДЕНИЕ ГОЛОВНЫХ ЧИСЕЛ КРИТИКА (W=90 H=30 N=3, $2000)`);
for (const key of ["median", "mean"]) {
  const r = walk({ tokens: full, W: 90, H: 30, N: 3, key });
  console.log(`  24 мажора, ранг по ${key.padEnd(6)}: APR ${pc(r.apr).padStart(8)}  брутто $${r.gross.toFixed(2)}  входов ${r.opens}  плюсовых периодов ${r.pos}/${r.periods}`);
}
console.log(`\n# «СПОКОЙНЫЙ» ФИЛЬТР: заглядывание против честного трейлинга`);
const peakYear = new Map(full.map((t) => [t, maxOf(all.get(t).map(annualizeRow).map((a) => Math.max(Math.abs(a.net_A), Math.abs(a.net_B))))]));
const tameLook = full.filter((t) => peakYear.get(t) <= 30);
console.log(`  вселенная критика (пик по ВСЕМУ году <= 30): ${tameLook.length} имён -> ${tameLook.join(",")}`);
const rLook = walk({ tokens: tameLook, W: 90, H: 30, N: 3, key: "median" });
console.log(`  ЗАГЛЯДЫВАНИЕ (фильтр по всему году):  APR ${pc(rLook.apr).padStart(8)}  плюсовых ${rLook.pos}/${rLook.periods}`);
const rTrail = walk({ tokens: full, W: 90, H: 30, N: 3, key: "median", calmTrail: 30 });
console.log(`  ЧЕСТНО (фильтр по обучающему окну):   APR ${pc(rTrail.apr).padStart(8)}  плюсовых ${rTrail.pos}/${rTrail.periods}`);

console.log(`\n# БАЗА: держать всю корзину равным весом, без отбора`);
const eq = walk({ tokens: full, W: 90, H: 30, N: full.length, key: "median" });
console.log(`  равный вес 24 имён: APR ${pc(eq.apr).padStart(8)}  брутто $${eq.gross.toFixed(2)}  входов ${eq.opens}`);

console.log(`\n# ТЕКУЩАЯ ВСЕЛЕННАЯ БОТА 1 (BTC, ETH)`);
const cur = walk({ tokens: ["BTC", "ETH"], W: 90, H: 30, N: 1, key: "median" });
console.log(`  BTC+ETH, топ-1: APR ${pc(cur.apr).padStart(8)}  плюсовых ${cur.pos}/${cur.periods}`);

console.log(`\n# УСТОЙЧИВОСТЬ: сетка по 24 мажорам, ранг по медиане`);
let cells = 0, positive = 0, lo = 1e9, hi = -1e9;
for (const W of [30, 60, 90, 180]) for (const H of [30, 60, 90]) for (const N of [1, 3, 5, 8]) {
  const r = walk({ tokens: full, W, H, N, key: "median" });
  cells++; if (r.apr > 0) positive++; lo = Math.min(lo, r.apr); hi = Math.max(hi, r.apr);
}
console.log(`  ячеек ${cells}, положительных ${positive}, диапазон ${pc(lo)} .. ${pc(hi)}`);

console.log(`\n# ВКЛАД ПО ИМЕНАМ (W=90 H=30 N=3, медиана) и что остаётся без топ-3 вкладчиков`);
const base = walk({ tokens: full, W: 90, H: 30, N: 3, key: "median" });
const top = [...base.byToken.entries()].sort((a, b) => b[1] - a[1]);
top.slice(0, 8).forEach(([t, g]) => console.log(`   ${t.padEnd(6)} брутто $${g.toFixed(2).padStart(9)}   пик|netAPR| за год ${peakYear.get(t).toFixed(1)}`));
const drop3 = full.filter((t) => !top.slice(0, 3).map((x) => x[0]).includes(t));
const rDrop = walk({ tokens: drop3, W: 90, H: 30, N: 3, key: "median" });
console.log(`   без трёх крупнейших (${top.slice(0,3).map(x=>x[0]).join(",")}): APR ${pc(rDrop.apr)}  плюсовых ${rDrop.pos}/${rDrop.periods}`);
