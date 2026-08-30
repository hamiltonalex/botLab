import fs from "node:fs";
import { all, YEAR, H1, scanTwoLeg, openPosition, accrueFromRows, closePosition,
         positionSummary, DEFAULT_COSTS, roundTripCost, pc } from "./skept-cap-lib.mjs";
// Десятка имён, живых в ОБОИХ периодах, на которой получен единственный устоявший результат +7.36%.
const TEN = ["BTC","ETH","SOL","BNB","XRP","DOGE","LINK","LTC","ARB","UNI"];
const CAP_SEC = 1e-7;
console.log("# ЗАГРЯЗНЕНЫ ЛИ ИМЕНА, НА КОТОРЫХ СТОИТ ЕДИНСТВЕННЫЙ УСТОЯВШИЙ РЕЗУЛЬТАТ\n");
console.log(`| имя | часов выше потолка | доля | худшая ставка % годовых | макс. серия одинаковых |`);
console.log(`|---|---|---|---|---|`);
for (const t of TEN) {
  const rows = all.get(t); if (!rows) continue;
  let bad = 0, worst = 0, run = 0, maxRun = 0, prev = null;
  for (const r of rows) {
    const mx = Math.max(Math.abs(r.f_long), Math.abs(r.f_short));
    const apr = mx * 3600 * 8760;
    if (apr > worst) worst = apr;
    if (mx > CAP_SEC) { bad++; if (r.f_long === prev) { run++; maxRun = Math.max(maxRun, run); } else run = 1; } else run = 0;
    prev = r.f_long;
  }
  console.log(`| ${t} | ${bad} | ${(100*bad/rows.length).toFixed(2)}% | ${(100*worst).toFixed(0)}% | ${maxRun} |`);
}

// Прогон десятки с ПОТОЛКОМ ставки: часы выше потолка приравниваются к потолку (не выбрасываются,
// чтобы не терять время из леджера). Сравнение с прогоном без потолка.
function capRows(rows, capSec) {
  if (!Number.isFinite(capSec)) return rows;
  return rows.map((r) => ({ ...r,
    f_long: Math.sign(r.f_long) * Math.min(Math.abs(r.f_long), capSec),
    f_short: Math.sign(r.f_short) * Math.min(Math.abs(r.f_short), capSec) }));
}
function walk({ src, tokens, W, H, N, capital = 2000 }) {
  const trainH = W * H1, holdH = H * H1, per = capital / N;
  const rt = roundTripCost(DEFAULT_COSTS, per, false);
  const len = Math.min(...tokens.map((t) => src.get(t).length));
  let gross = 0, opens = 0, held = new Set(); const byPeriod = [];
  for (let i = trainH; i + 24 <= len; i += holdH) {
    const te = Math.min(len, i + holdH); if (te - i < 24) break;
    const cand = [];
    for (const t of tokens) {
      const rows = src.get(t);
      const sc = scanTwoLeg(rows.slice(i - trainH, i), { token: t }); if (!sc) continue;
      const b = sc.chosen === "A" ? sc.A : sc.B;
      if (Number.isFinite(b.netMedian) && b.netMedian > 0) cand.push({ t, cfg: sc.chosen, v: b.netMedian });
    }
    cand.sort((x, y) => y.v - x.v);
    const sel = cand.slice(0, N); let pg = 0, po = 0;
    for (const s of sel) {
      const rr = src.get(s.t).slice(i, te);
      const t0 = rr[0].tsHour * 1000, t1 = rr[rr.length-1].tsHour * 1000 + 3600000;
      const p = openPosition({ strategy: "two", instrumentKey: s.t, config: s.cfg, capital: per, leverage: 1, nowMs: t0, roundTripCost: 0 });
      accrueFromRows(p, rr, t1); closePosition(p, t1);
      const g = positionSummary(p).grossPnl; gross += g; pg += g;
      if (!held.has(s.t + s.cfg)) { opens++; po++; }
    }
    held = new Set(sel.map((s) => s.t + s.cfg));
    byPeriod.push(pg - po * rt);
  }
  const yrs = (len - trainH) / 8760;
  return { apr: (gross - opens * rt) / capital / yrs, pos: byPeriod.filter((x) => x > 0).length, n: byPeriod.length };
}
console.log(`\n# ПЕРИОД 1 (2025-06..2026-06), десятка имён, W=90 H=30 N=3`);
console.log(`| потолок ставки | APR | плюсовых |`);
console.log(`|---|---|---|`);
for (const [lbl, c] of [["без потолка", Infinity], ["315% годовых (1e-7/с)", 1e-7], ["1000% годовых", 3.17e-7]]) {
  const src = new Map(TEN.map((t) => [t, capRows(all.get(t), c)]));
  const r = walk({ src, tokens: TEN, W: 90, H: 30, N: 3 });
  console.log(`| ${lbl} | ${pc(r.apr)} | ${r.pos}/${r.n} |`);
}
// Второй период
const y2 = new Map();
for (const t of TEN) { const p = `${new URL(".", import.meta.url).pathname}y2/${t}.csv`;
  if (fs.existsSync(p)) { const { parseSpreadCsv } = await import("./skept-cap-lib.mjs");
    y2.set(t, parseSpreadCsv(fs.readFileSync(p, "utf8"))); } }
if (y2.size === TEN.length) {
  console.log(`\n# ПЕРИОД 2 (2023-09..2025-06), та же десятка`);
  console.log(`| потолок ставки | APR | плюсовых |`);
  console.log(`|---|---|---|`);
  const minLen = Math.min(...TEN.map((t) => y2.get(t).length));
  for (const [lbl, c] of [["без потолка", Infinity], ["315% годовых", 1e-7], ["1000% годовых", 3.17e-7]]) {
    const src = new Map(TEN.map((t) => [t, capRows(y2.get(t).slice(-minLen), c)]));
    const r = walk({ src, tokens: TEN, W: 90, H: 30, N: 3 });
    console.log(`| ${lbl} | ${pc(r.apr)} | ${r.pos}/${r.n} |`);
  }
}
