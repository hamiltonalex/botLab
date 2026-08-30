// Достраивает impact-gmx.json верхним хвостом: полосы от $200k до >$5M по 2000 крупнейшим сделкам рынка.
import fs from "node:fs";
import { SP, q } from "./imp-gmx-lib.mjs";
const J = JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`, "utf8"));
const T = JSON.parse(fs.readFileSync(`${SP}/imp-tail.json`, "utf8"));
const E = [200e3, 500e3, 1e6, 2e6, 5e6, Infinity];
const L = ["$200-500k", "$500k-1M", "$1-2M", "$2-5M", ">=$5M"];
const bx = (s) => { for (let i = E.length - 2; i >= 0; i--) if (s >= E[i]) return i; return -1; };
const st = (a) => a.length ? { n: a.length, med: q(0.5, a.map((r) => r.bps)), p25: q(0.25, a.map((r) => r.bps)), p75: q(0.75, a.map((r) => r.bps)),
  mean: a.reduce((s, r) => s + r.bps, 0) / a.length, shareRebate: a.filter((r) => r.bps > 0).length / a.length, medSizeUsd: q(0.5, a.map((r) => r.size)) } : { n: 0 };

const POOL = { long: L.map(() => []), short: L.map(() => []), all: L.map(() => []) };
const tailOut = {};
for (const [t, rows] of Object.entries(T.byMarket)) {
  const minInList = rows.length ? rows[rows.length - 1][3] : Infinity;
  const covered = rows.length < 2000 ? 0 : minInList;      // полосы ниже этого порога неполны
  const bins = { long: L.map(() => []), short: L.map(() => []) };
  let maxSize = 0, maxRow = null;
  for (const [ts, ot, isL, size, imp] of rows) {
    if (size > maxSize) { maxSize = size; maxRow = { sizeUsd: size, bps: 1e4 * imp / size, isLong: !!isL, orderType: ot }; }
    if (ot === 7) continue; if (![2, 3, 8, 4, 5, 6].includes(ot)) continue;
    const b = bx(size); if (b < 0) continue;
    const r = { size, bps: 1e4 * imp / size };
    bins[isL ? "long" : "short"][b].push(r);
    POOL[isL ? "long" : "short"][b].push(r); POOL.all[b].push(r);
  }
  tailOut[t] = { listedTrades: rows.length, smallestInList: rows.length ? minInList : null,
    bandsComplete: L.map((_, b) => rows.length < 2000 || E[b] >= covered),
    maxTrade: maxRow,
    long: bins.long.map((a, b) => ({ band: L[b], loUsd: E[b], hiUsd: E[b + 1] === Infinity ? null : E[b + 1], ...st(a) })),
    short: bins.short.map((a, b) => ({ band: L[b], loUsd: E[b], hiUsd: E[b + 1] === Infinity ? null : E[b + 1], ...st(a) })) };
}
J.tail = { meta: { bands: L, edgesUsd: E.map((x) => (x === Infinity ? null : x)),
  source: "2000 крупнейших исполненных сделок рынка за период (orderBy sizeDeltaUsd_DESC); полоса полна, если её нижняя граница выше наименьшей сделки в списке",
  note: "ликвидации (orderType=7) исключены из полос, но учтены в maxTrade" },
  pooled: Object.fromEntries(Object.entries(POOL).map(([k, v]) => [k, v.map((a, b) => ({ band: L[b], loUsd: E[b], hiUsd: E[b + 1] === Infinity ? null : E[b + 1], ...st(a) }))])),
  byMarket: tailOut };
fs.writeFileSync(`${SP}/impact-gmx.json`, JSON.stringify(J));

const f = (x, d = 2) => (x == null ? "-" : (x >= 0 ? "+" : "") + x.toFixed(d));
console.log("=== ВЕРХНИЙ ХВОСТ, все рынки вместе, медиана bps [p25/p75] ===");
for (const side of ["short", "long"]) { console.log(` сторона GMX = ${side} (конфиг ${side === "short" ? "A" : "B"})`);
  for (const r of J.tail.pooled[side]) console.log("   ", r.band.padEnd(10), r.n ? `мед ${f(r.med).padStart(8)}  p25 ${f(r.p25).padStart(8)}  p75 ${f(r.p75).padStart(8)}  n=${String(r.n).padStart(5)}  рибейт ${(100 * r.shareRebate).toFixed(0)}%` : "нет сделок такого размера"); }
console.log("\n=== ПОЛНАЯ ЛЕСТНИЦА (мелкие корзины + хвост), медиана bps, сводно ===");
const lad = [...J.pooled.short.map((r, i) => ({ b: J.meta.labels[i], s: r, l: J.pooled.long[i] })),
  ...J.tail.pooled.short.map((r, i) => ({ b: L[i], s: r, l: J.tail.pooled.long[i] }))];
for (const r of lad) console.log("  ", r.b.padEnd(10), `шорт ${r.s.n ? f(r.s.med).padStart(8) + " n=" + String(r.s.n).padStart(6) : "  нет".padStart(8) + "       "}   лонг ${r.l.n ? f(r.l.med).padStart(8) + " n=" + String(r.l.n).padStart(6) : "  нет"}`);
console.log("\n=== КРУПНЕЙШАЯ СДЕЛКА ГОДА ПО РЫНКАМ (топ-15 по размеру) ===");
const mx = Object.entries(tailOut).filter(([, v]) => v.maxTrade).sort((a, b) => b[1].maxTrade.sizeUsd - a[1].maxTrade.sizeUsd);
for (const [t, v] of mx.slice(0, 15)) console.log(`  ${t.padEnd(10)} $${Math.round(v.maxTrade.sizeUsd).toLocaleString("en-US").padStart(12)}  impact ${f(v.maxTrade.bps).padStart(8)} bps  ${v.maxTrade.isLong ? "лонг" : "шорт"}`);
console.log("\n  медиана максимальной сделки по 63 рынкам: $" + Math.round(q(0.5, mx.map(([, v]) => v.maxTrade.sizeUsd))).toLocaleString("en-US"));
