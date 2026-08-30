// В17. Керри по месяцам: держится ли 12% годовых или это остаток от первых месяцев.
import fs from "node:fs";
import { all, openPosition, accrueFromRows, closePosition, SP } from "./skept-cap-lib.mjs";
const oos = JSON.parse(fs.readFileSync(`${SP}/bas-v-oos.json`, "utf8"));
const N = 100000;
const carry = (rows) => { if (rows.length < 24) return null;
  const t0 = rows[0].tsHour * 1000, tN = rows.at(-1).tsHour * 1000 + 3600000;
  const p = openPosition({ strategy: "two", instrumentKey: "x", config: "B", capital: N, leverage: 1, nowMs: t0, roundTripCost: 0 });
  accrueFromRows(p, rows, tN); closePosition(p, tN);
  const hl = p.accruals.reduce((a, x) => a + x.dPnlHl, 0), h = p.accruals.reduce((a, x) => a + x.hlSettlements, 0);
  return h ? (hl / N) * (8760 / h) : null; };
const mk = (l) => l.map((x) => ({ tsHour: Math.floor(x.time / 1000 / 3600) * 3600, f_long: 0, f_short: 0, b_long: 0, b_short: 0, hl_rate: Number(x.fundingRate) }));
const COINS = ["HYPE", "BTC", "ETH", "SOL", "XMR", "PUMP"];
const months = new Map();
for (const t of COINS) {
  const rows = [...(all.get(t) || []).map((r) => ({ tsHour: r.tsHour, f_long: 0, f_short: 0, b_long: 0, b_short: 0, hl_rate: r.hl_rate })), ...mk(oos[t] || [])];
  const seen = new Map(); for (const r of rows) if (Number.isFinite(r.hl_rate)) seen.set(r.tsHour, r);
  const srt = [...seen.values()].sort((a, b) => a.tsHour - b.tsHour);
  const by = new Map();
  for (const r of srt) { const k = new Date(r.tsHour * 1000).toISOString().slice(0, 7); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  for (const [m, rs] of by) { if (!months.has(m)) months.set(m, {}); months.get(m)[t] = carry(rs); }
}
const keys = [...months.keys()].sort();
console.log("КЕРРИ ШОРТА ПЕРПА ПО МЕСЯЦАМ (движок, конфиг B), % годовых. кэш до 2026-06, дальше живая история:");
console.log("месяц".padEnd(9) + COINS.map((c) => c.padStart(9)).join(""));
for (const m of keys) console.log(m.padEnd(9) + COINS.map((c) => { const v = months.get(m)[c]; return (v === null || v === undefined ? "-" : (v * 100).toFixed(1)).padStart(9); }).join(""));
const last6 = keys.slice(-7, -1);
console.log("\nсреднее за последние 6 полных месяцев:");
console.log("".padEnd(9) + COINS.map((c) => { const v = last6.map((m) => months.get(m)[c]).filter((x) => x !== null && x !== undefined); return (v.length ? (v.reduce((a, x) => a + x, 0) / v.length * 100).toFixed(1) : "-").padStart(9); }).join(""));
