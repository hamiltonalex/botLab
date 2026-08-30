import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
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
const MIJSON=STUDY_DATA+"/mi.json", MIAVAX=STUDY_DATA+"/mi-avax.json", SCAN=STUDY_CACHE+"/_scan_results.csv";
// Возраст рынка GMX на начало прогона (2025-06-20) из listingDate краника markets/info.
const lines2 = fs.readFileSync(SCAN, "utf8").trim().split("\n");
const ix2 = Object.fromEntries(lines2[0].split(",").map((h, i) => [h, i]));
const addr = new Map(lines2.slice(1).map((l) => { const p = l.split(","); return [p[ix2.token], (p[ix2.gmx_market] || "").toLowerCase()]; }));
const listing = new Map();
for (const f of [MIJSON, MIAVAX]) for (const m of (JSON.parse(fs.readFileSync(f, "utf8")).markets ?? []))
  listing.set(m.marketToken.toLowerCase(), (m.listingDate || "").slice(0, 10));
const ageOf = (t) => listing.get(addr.get(t)) ?? "?";

const START = "2025-06-20";
const rows = full.map((t) => ({ t, listed: ageOf(t) })).sort((a, b) => a.listed.localeCompare(b.listed));
console.log(`\n\n# ВОЗРАСТ РЫНКА GMX НА НАЧАЛО ПРОГОНА (${START})\n`);
const base = walk({ tokens: full, W: 90, H: 30, N: 3, key: "median" });
const contrib = base.byToken;
console.log(`| токен | листинг рынка GMX | вклад в брутто $ |`);
console.log(`|---|---|---|`);
for (const r of rows) console.log(`| ${r.t} | ${r.listed} | ${(contrib.get(r.t) ?? 0).toFixed(2)} |`);

const CUT = "2024-06-01";
const old = rows.filter((r) => r.listed && r.listed < CUT).map((r) => r.t);
const neu = rows.filter((r) => r.listed && r.listed >= CUT).map((r) => r.t);
console.log(`\n# РАСКОЛ ПО ВОЗРАСТУ (граница ${CUT})`);
console.log(`  СТАРЫЕ рынки (${old.length}): ${old.join(", ")}`);
console.log(`  НОВЫЕ рынки (${neu.length}): ${neu.join(", ")}`);
const gOld = old.reduce((s, t) => s + (contrib.get(t) ?? 0), 0);
const gNew = neu.reduce((s, t) => s + (contrib.get(t) ?? 0), 0);
console.log(`  брутто со СТАРЫХ $${gOld.toFixed(2)} | с НОВЫХ $${gNew.toFixed(2)} | доля новых ${(100*gNew/(gOld+gNew)).toFixed(1)}%`);

console.log(`\n# ПРОГОН ОТДЕЛЬНО ПО КАЖДОЙ ГРУППЕ (период 2025-06..2026-06)`);
console.log(`| вселенная | имён | W=90 H=30 N=3 | плюсовых | W=90 H=30 N=1 |`);
console.log(`|---|---|---|---|---|`);
for (const [name, uni] of [["все", full], ["только СТАРЫЕ", old], ["только НОВЫЕ", neu]]) {
  if (uni.length < 3) { console.log(`| ${name} | ${uni.length} | мало имён | - | - |`); continue; }
  const a = walk({ tokens: uni, W: 90, H: 30, N: 3, key: "median" });
  const b = walk({ tokens: uni, W: 90, H: 30, N: 1, key: "median" });
  console.log(`| ${name} | ${uni.length} | ${pc(a.apr)} | ${a.pos}/${a.periods} | ${pc(b.apr)} |`);
}
