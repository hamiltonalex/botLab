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

// ── ФИЛЬТР ЁМКОСТИ. Узкое место = min(свободная ликвидность GMX своей стороны, 1% суточного
// оборота HL). Доля 1% это МОЁ допущение о том, сколько дневного оборота можно взять, не двигая
// цену; она названа явно и меняется одной константой.
const cap = new Map(JSON.parse(fs.readFileSync(STUDY_DATA+"/capacity.json", "utf8"))
  .map((r) => [r.t, Math.min(r.avail, r.hlVol * 0.01)]));
const HL_SHARE_NOTE = "1% суточного оборота HL";

console.log(`\n\n# ПРОГОН С ФИЛЬТРОМ ЁМКОСТИ (узкое место = min(свободно GMX, ${HL_SHARE_NOTE}))`);
console.log(`# Ёмкость снята СЕГОДНЯ, прогон идёт по 2025-06..2026-06: приближение, названное приближением.\n`);
console.log(`| капитал | размер слота | запас x | имён проходит | APR вне выборки | плюсовых |`);
console.log(`|---|---|---|---|---|---|`);
for (const capital of [2000, 10000, 100000]) {
  for (const mult of [1, 5, 20]) {
    const per = capital / 3;
    const pass = full.filter((t) => (cap.get(t) ?? 0) >= mult * per);
    if (pass.length < 3) { console.log(`| $${capital} | $${per.toFixed(0)} | ${mult}x | ${pass.length} | вселенная меньше трёх | - |`); continue; }
    const r = walk({ tokens: pass, W: 90, H: 30, N: 3, key: "median", capital });
    console.log(`| $${capital} | $${per.toFixed(0)} | ${mult}x | ${pass.length} | ${pc(r.apr)} | ${r.pos}/${r.periods} |`);
  }
}

console.log(`\n# ЧТО ИМЕННО ОТСЕИВАЕТСЯ (капитал $2000, слот $667, запас 5x = нужно $3333)`);
const need = 5 * (2000 / 3);
const kept = full.filter((t) => (cap.get(t) ?? 0) >= need);
const cut = full.filter((t) => (cap.get(t) ?? 0) < need);
console.log(`  проходят (${kept.length}): ${kept.join(", ")}`);
console.log(`  отсеяны  (${cut.length}): ${cut.join(", ")}`);
const base = walk({ tokens: full, W: 90, H: 30, N: 3, key: "median" });
const top = [...base.byToken.entries()].sort((a, b) => b[1] - a[1]);
const grossAll = top.reduce((s, x) => s + x[1], 0);
const grossCut = top.filter(([t]) => cut.includes(t)).reduce((s, x) => s + x[1], 0);
console.log(`  доля брутто, пришедшая с ОТСЕЯННЫХ имён: $${grossCut.toFixed(2)} из $${grossAll.toFixed(2)} = ${(100 * grossCut / grossAll).toFixed(1)}%`);

console.log(`\n# КОНТРОЛЬ: та же сетка только на именах, которые ёмкость проходят при запасе 5x`);
let cells = 0, positive = 0, lo = 1e9, hi = -1e9;
for (const W of [30, 60, 90, 180]) for (const H of [30, 60, 90]) for (const N of [1, 3]) {
  if (kept.length < N) continue;
  const r = walk({ tokens: kept, W, H, N, key: "median" });
  cells++; if (r.apr > 0) positive++; lo = Math.min(lo, r.apr); hi = Math.max(hi, r.apr);
}
console.log(`  ячеек ${cells}, положительных ${positive}, диапазон ${pc(lo)} .. ${pc(hi)}`);
