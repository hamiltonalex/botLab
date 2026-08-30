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
const CAPJSON = STUDY_DATA+"/capacity.json";
const capRows = JSON.parse(fs.readFileSync(CAPJSON, "utf8"));
const bottleneck = (share) => new Map(capRows.map((r) => [r.t, Math.min(r.avail, r.hlVol * share)]));

console.log(`\n\n# ПОТОЛОК КАПИТАЛА: где край гаснет`);
console.log(`# Запас 5x к размеру слота. Доля суточного оборота HL, которую считаем берущейся, варьируется.\n`);
for (const share of [0.005, 0.01, 0.05]) {
  const cap = bottleneck(share);
  console.log(`## доля оборота HL = ${(share * 100).toFixed(1)}%`);
  console.log(`| капитал | имён | APR | плюсовых | доход $/год |`);
  console.log(`|---|---|---|---|---|`);
  for (const capital of [2000, 5000, 10000, 20000, 50000, 100000]) {
    const per = capital / 3, need = 5 * per;
    const pass = full.filter((t) => (cap.get(t) ?? 0) >= need);
    if (pass.length < 3) { console.log(`| $${capital} | ${pass.length} | вселенная меньше трёх | - | - |`); continue; }
    const r = walk({ tokens: pass, W: 90, H: 30, N: 3, key: "median", capital });
    console.log(`| $${capital} | ${pass.length} | ${pc(r.apr)} | ${r.pos}/${r.periods} | $${(r.apr * capital).toFixed(0)} |`);
  }
  console.log("");
}

console.log(`# ЧУВСТВИТЕЛЬНОСТЬ К ЗАПАСУ (доля оборота HL 1%, капитал $10000)`);
console.log(`| запас | имён | APR |`);
console.log(`|---|---|---|`);
const cap1 = bottleneck(0.01);
for (const mult of [1, 2, 5, 10, 20]) {
  const per = 10000 / 3;
  const pass = full.filter((t) => (cap1.get(t) ?? 0) >= mult * per);
  if (pass.length < 3) { console.log(`| ${mult}x | ${pass.length} | вселенная меньше трёх |`); continue; }
  const r = walk({ tokens: pass, W: 90, H: 30, N: 3, key: "median", capital: 10000 });
  console.log(`| ${mult}x | ${pass.length} | ${pc(r.apr)} |`);
}

console.log(`\n# ЧИСТЫЙ ДОХОД В ДОЛЛАРАХ ПРОТИВ КАПИТАЛА (доля 1%, запас 5x)`);
console.log(`Это главное число: процент растёт вниз, а доллары вверх, и максимум лежит посередине.`);
console.log(`| капитал | имён | APR | $/год |`);
console.log(`|---|---|---|---|`);
let best = null;
for (const capital of [2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 50000]) {
  const per = capital / 3, need = 5 * per;
  const pass = full.filter((t) => (cap1.get(t) ?? 0) >= need);
  if (pass.length < 3) { console.log(`| $${capital} | ${pass.length} | вселенная меньше трёх | - |`); continue; }
  const r = walk({ tokens: pass, W: 90, H: 30, N: 3, key: "median", capital });
  const usd = r.apr * capital;
  if (!best || usd > best.usd) best = { capital, usd, apr: r.apr, n: pass.length };
  console.log(`| $${capital} | ${pass.length} | ${pc(r.apr)} | $${usd.toFixed(0)} |`);
}
console.log(`\nМАКСИМУМ ДОХОДА: $${best.usd.toFixed(0)} в год при капитале $${best.capital} (${pc(best.apr)}, ${best.n} имён).`);
