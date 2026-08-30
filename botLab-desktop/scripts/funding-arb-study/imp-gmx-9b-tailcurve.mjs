// Верхний хвост с разделением на два режима протокола и на открытие/закрытие.
// preOpen  = мгновенный impact ВХОДА сделки размера X (июнь-август 2025, impact ещё брался на входе)
// postClose= весь круг impact в нынешнем режиме (с октября 2025 вход даёт ноль, всё оседает на выходе)
import fs from "node:fs";
import { SP, q } from "./imp-gmx-lib.mjs";
const J = JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`, "utf8"));
const T = JSON.parse(fs.readFileSync(`${SP}/imp-tail.json`, "utf8"));
const E = [200e3, 500e3, 1e6, 2e6, 5e6, Infinity];
const L = ["$200-500k", "$500k-1M", "$1-2M", "$2-5M", ">=$5M"];
const bx = (s) => { for (let i = E.length - 2; i >= 0; i--) if (s >= E[i]) return i; return -1; };
const INC = new Set([2, 3, 8]), DEC = new Set([4, 5, 6]);
const PRE = 1756684800, POST = 1759276800;
const st = (a) => a.length ? { n: a.length, med: q(0.5, a.map((r) => r.bps)), p25: q(0.25, a.map((r) => r.bps)), p75: q(0.75, a.map((r) => r.bps)),
  p05: q(0.05, a.map((r) => r.bps)), p95: q(0.95, a.map((r) => r.bps)), mean: a.reduce((s, r) => s + r.bps, 0) / a.length,
  shareRebate: a.filter((r) => r.bps > 0).length / a.length, medSizeUsd: q(0.5, a.map((r) => r.size)) } : { n: 0 };
const VIEWS = ["preOpen", "preClose", "postClose"];
const mk = () => Object.fromEntries(VIEWS.map((v) => [v, { long: L.map(() => []), short: L.map(() => []) }]));
const POOL = mk(), byMarket = {};
for (const [t, rows] of Object.entries(T.byMarket)) {
  const local = mk(); let maxRow = null;
  for (const [ts, ot, isL, size, imp] of rows) {
    const bps = 1e4 * imp / size, side = isL ? "long" : "short";
    if (!maxRow || size > maxRow.sizeUsd) maxRow = { sizeUsd: size, bps, isLong: !!isL, orderType: ot, ts };
    if (ot === 7) continue;
    const b = bx(size); if (b < 0) continue;
    const inc = INC.has(ot), dec = DEC.has(ot); if (!inc && !dec) continue;
    const v = ts < PRE ? (inc ? "preOpen" : "preClose") : ts >= POST ? (inc ? null : "postClose") : null;
    if (!v) continue;
    const r = { size, bps };
    local[v][side][b].push(r); POOL[v][side][b].push(r);
  }
  byMarket[t] = { listedTrades: rows.length, smallestInList: rows.length ? rows[rows.length - 1][3] : null,
    bandsComplete: L.map((_, b) => rows.length < 2000 || E[b] >= rows[rows.length - 1][3]), maxTrade: maxRow,
    ...Object.fromEntries(VIEWS.map((v) => [v, { long: local[v].long.map((a, b) => ({ band: L[b], loUsd: E[b], hiUsd: E[b + 1] === Infinity ? null : E[b + 1], ...st(a) })),
      short: local[v].short.map((a, b) => ({ band: L[b], loUsd: E[b], hiUsd: E[b + 1] === Infinity ? null : E[b + 1], ...st(a) })) }])) };
}
J.tail = { meta: { bands: L, edgesUsd: E.map((x) => (x === Infinity ? null : x)),
  source: "2000 крупнейших исполненных сделок каждого рынка за период (orderBy sizeDeltaUsd_DESC)",
  views: { preOpen: "вход в позицию до 01.09.2025: мгновенный impact сделки такого размера",
    preClose: "выход из позиции до 01.09.2025", postClose: "выход с 01.10.2025: несёт ВЕСЬ impact круга, потому что вход теперь даёт ровно ноль" },
  note: "ликвидации (orderType=7) исключены из полос, но учтены в maxTrade; полоса полна, если её нижняя граница выше наименьшей сделки в списке" },
  pooled: Object.fromEntries(VIEWS.map((v) => [v, { long: POOL[v].long.map((a, b) => ({ band: L[b], loUsd: E[b], hiUsd: E[b + 1] === Infinity ? null : E[b + 1], ...st(a) })),
    short: POOL[v].short.map((a, b) => ({ band: L[b], loUsd: E[b], hiUsd: E[b + 1] === Infinity ? null : E[b + 1], ...st(a) })) }])),
  byMarket };
fs.writeFileSync(`${SP}/impact-gmx.json`, JSON.stringify(J));
const f = (x, d = 2) => (x == null ? "-" : (x >= 0 ? "+" : "") + x.toFixed(d));
for (const v of VIEWS) { console.log(`\n=== ХВОСТ, вид ${v} ===`);
  for (const side of ["short", "long"]) { console.log(` GMX ${side} (конфиг ${side === "short" ? "A" : "B"})`);
    for (const r of J.tail.pooled[v][side]) console.log("   ", r.band.padEnd(10), r.n ? `мед ${f(r.med).padStart(8)} средн ${f(r.mean).padStart(8)} p25 ${f(r.p25).padStart(8)} p75 ${f(r.p75).padStart(8)} n=${String(r.n).padStart(5)}` : "нет сделок такого размера"); } }
console.log("\n=== ЛЕСТНИЦА ВХОДА (preOpen, до отложенного impact): мгновенная цена сделки размера X ===");
const small = J.regimes ? null : null;
for (let b = 0; b < 6; b++) { const s = J.pooled.pre_short_open[b], l = J.pooled.pre_long_open[b];
  console.log("  ", J.meta.labels[b].padEnd(10), `шорт мед ${f(s.med).padStart(7)} средн ${f(s.mean).padStart(7)} n=${String(s.n).padStart(6)}   лонг мед ${f(l.med).padStart(7)} средн ${f(l.mean).padStart(7)} n=${String(l.n).padStart(6)}`); }
for (let b = 0; b < 5; b++) { const s = J.tail.pooled.preOpen.short[b], l = J.tail.pooled.preOpen.long[b];
  console.log("  ", L[b].padEnd(10), `шорт мед ${s.n ? f(s.med).padStart(7) + " средн " + f(s.mean).padStart(7) + " n=" + String(s.n).padStart(6) : "нет"}   лонг мед ${l.n ? f(l.med).padStart(7) + " средн " + f(l.mean).padStart(7) + " n=" + String(l.n).padStart(6) : "нет"}`); }
