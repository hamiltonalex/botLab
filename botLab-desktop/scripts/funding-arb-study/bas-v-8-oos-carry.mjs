// В8. Вне выборки, тем же движком. Сначала сверяем поле fundingRate живого API с hl_rate кэша
// на перекрытии - иначе продолжение ряда было бы склейкой двух разных величин.
import fs from "node:fs";
import { all, openPosition, accrueFromRows, closePosition, SP } from "./skept-cap-lib.mjs";
const API = "https://api.hyperliquid.xyz/info";
const post = async (b) => { const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return r.ok ? r.json() : null; };
const oos = JSON.parse(fs.readFileSync(`${SP}/bas-v-oos.json`, "utf8"));
const COINS = Object.keys(oos);

// --- сверка на перекрытии ---
console.log("СВЕРКА живого fundingHistory с hl_rate кэша (последние 10 суток кэша):");
const ovStart = Date.parse("2026-06-10T00:00:00Z"), ovEnd = Date.parse("2026-06-20T07:00:00Z");
for (const c of COINS.slice(0, 5)) {
  const live = await post({ type: "fundingHistory", coin: c, startTime: ovStart, endTime: ovEnd });
  const rows = all.get(c); if (!rows || !live) { console.log(c, "нет"); continue; }
  const byH = new Map(rows.map((r) => [r.tsHour, r.hl_rate]));
  let n = 0, bad = 0, maxd = 0;
  for (const l of live) { const h = Math.floor(l.time / 1000 / 3600) * 3600; const v = byH.get(h); if (v === undefined) continue; n++; const d = Math.abs(v - Number(l.fundingRate)); maxd = Math.max(maxd, d); if (d > 1e-12) bad++; }
  console.log(`  ${c.padEnd(6)} совпавших часов ${String(n).padStart(4)}, расхождений ${bad}, максимум |Δ| = ${maxd.toExponential(2)}`);
}

// --- строим канонические строки и гоняем движком ---
const mkRows = (list) => list.map((l) => ({ ts: new Date(l.time).toISOString(), tsHour: Math.floor(l.time / 1000 / 3600) * 3600,
  f_long: 0, f_short: 0, b_long: 0, b_short: 0, hl_rate: Number(l.fundingRate), hl_premium: Number(l.premium) }));
const NOTIONAL = 100000;
const carry = (rows) => {
  const t0 = rows[0].tsHour * 1000, tN = rows.at(-1).tsHour * 1000 + 3600000;
  const p = openPosition({ strategy: "two", instrumentKey: "x", config: "B", capital: NOTIONAL, leverage: 1, nowMs: t0, roundTripCost: 0 });
  accrueFromRows(p, rows, tN); closePosition(p, tN);
  const hl = p.accruals.reduce((a, x) => a + x.dPnlHl, 0);
  const hrs = p.accruals.reduce((a, x) => a + x.hlSettlements, 0);
  return { hl, hrs, apr: (hl / NOTIONAL) * (8760 / hrs) };
};
const inS = JSON.parse(fs.readFileSync(`${SP}/bas-v-carry.json`, "utf8")).res;
console.log(`\nВНЕ ВЫБОРКИ: 2026-06-20 .. 2026-08-30 (${(1713 / 24).toFixed(1)} суток), тот же движок, конфиг B`);
console.log("монета".padEnd(9) + "в выборке".padStart(11) + "вне выборки".padStart(13) + "  разница" + "     керри $ на $100k за 71 сутки");
const res = {};
for (const c of COINS) {
  const rows = mkRows(oos[c]); const o = carry(rows); res[c] = o;
  const i = inS[c]?.full?.apr;
  console.log(`${c.padEnd(9)}${i !== undefined ? (i * 100).toFixed(2).padStart(10) + "%" : "       нет"}${(o.apr * 100).toFixed(2).padStart(12)}%${((o.apr - (i || 0)) * 100).toFixed(2).padStart(9)} пп ${o.hl.toFixed(0).padStart(12)}`);
}
fs.writeFileSync(`${SP}/bas-v-oos-carry.json`, JSON.stringify(res, null, 1));
