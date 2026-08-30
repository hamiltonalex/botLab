import fs from "node:fs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30 = 1e30, YR = 3600 * 8760;
export function loadCache(tok) {
  const rows = cacheRows(tok); if (!rows) return null;
  const m = new Map();
  for (const r of rows) {
    const h = Math.floor(Date.parse(r.ts.replace(" ", "T")) / 1000 / 3600) * 3600;
    m.set(h, { fl: +r.f_long, fs: +r.f_short });
  }
  return m;
}
// средняя |ставка| стороны по кэшу на интервале [a,b) секунд
export function cacheAvg(cm, a, b, isLong) {
  let s = 0, n = 0;
  for (let h = Math.floor(a / 3600) * 3600; h < b; h += 3600) {
    const v = cm.get(h); if (!v) continue;
    s += Math.abs(isLong ? v.fl : v.fs); n++;
  }
  return n ? { avg: s / n, n } : null;
}
export function analyse(tok) {
  const tr = JSON.parse(fs.readFileSync(`truth-b-raw/${tok}.json`, "utf8"));
  const cm = loadCache(tok);
  const byKey = new Map();
  for (const t of tr) { if (!byKey.has(t.positionKey)) byKey.set(t.positionKey, []); byKey.get(t.positionKey).push(t); }
  const iv = [];
  let totalFundUsd = 0;
  for (const t of tr) totalFundUsd += Number(t.fundingFeeAmount) * Number(t.collateralTokenPriceMin) / E30;
  for (const arr of byKey.values()) {
    arr.sort((x, y) => x.timestamp - y.timestamp || (x.id < y.id ? -1 : 1));
    for (let i = 1; i < arr.length; i++) {
      const p = arr[i - 1], c = arr[i];
      const dt = c.timestamp - p.timestamp; if (dt <= 0) continue;
      const held = Number(p.positionSizeInUsd) / E30; if (!(held > 0)) continue;
      if (p.isLong !== c.isLong) continue;              // разные позиции под одним ключом
      const fund = Number(c.fundingFeeAmount) * Number(c.collateralTokenPriceMin) / E30;
      if (!(fund >= 0)) continue;
      const nt = held * dt;                              // ноционал-секунды
      const ca = cm ? cacheAvg(cm, p.timestamp, c.timestamp, c.isLong) : null;
      iv.push({ dt, held, nt, fund, rate: fund / nt, isLong: c.isLong, cache: ca ? ca.avg : null, ts: p.timestamp });
    }
  }
  return { tok, iv, totalFundUsd, nTrades: tr.length };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const TARGETS = process.argv.slice(2);
  console.log("токен  интервалов  ноционал-часов   ФАКТ %год   КЭШ %год    КЭШ/ФАКТ   фандинг всего $");
  for (const t of TARGETS) {
    const a = analyse(t);
    const paid = a.iv.filter(x => x.fund > 0);
    const sNT = paid.reduce((s, x) => s + x.nt, 0);
    const sF = paid.reduce((s, x) => s + x.fund, 0);
    const withC = paid.filter(x => x.cache != null);
    const sNT2 = withC.reduce((s, x) => s + x.nt, 0);
    const sC = withC.reduce((s, x) => s + x.cache * x.nt, 0);
    const factR = sF / sNT, cacheR = sC / sNT2;
    console.log(t.padEnd(8), String(paid.length).padStart(7), (sNT/3600).toExponential(3).padStart(12),
      (factR*YR*100).toFixed(2).padStart(11), (cacheR*YR*100).toFixed(0).padStart(10),
      (cacheR/factR).toFixed(1).padStart(11), "  $" + Math.round(a.totalFundUsd).toLocaleString("ru-RU"));
  }
}
