// В6. Керри шорта перпа HL, посчитанное ДВИЖКОМ (конфиг B, вклад ноги = сумма dPnlHl из журнала).
// Своей арифметики начисления здесь нет: openPosition/accrueFromRows/closePosition/positionSummary.
import fs from "node:fs";
import { all, YEAR, openPosition, accrueFromRows, closePosition, positionSummary, SP } from "./skept-cap-lib.mjs";

const NOTIONAL = 100000; // ноциональ ноги; керри линеен по ноциналу, доля от него = годовая ставка
export function carry(rows, notional = NOTIONAL) {
  if (!rows || rows.length < 2) return null;
  const t0 = rows[0].tsHour * 1000, tN = rows[rows.length - 1].tsHour * 1000 + 3600000;
  const p = openPosition({ strategy: "two", instrumentKey: "x", config: "B", capital: notional, leverage: 1, nowMs: t0, roundTripCost: 0 });
  accrueFromRows(p, rows, tN);
  closePosition(p, tN);
  const hl = p.accruals.reduce((a, x) => a + x.dPnlHl, 0);
  const hrs = p.accruals.reduce((a, x) => a + x.hlSettlements, 0);
  const s = positionSummary(p);
  return { hl, hrs, notional, apr: (hl / notional) * (8760 / Math.max(hrs, 1)), gross: s.grossPnl,
           dPnlGmx: p.accruals.reduce((a, x) => a + x.dPnlGmx, 0) };
}

const rowsOf = (t) => all.get(t);
const wanted = ["HYPE", "ZEC", "BTC", "ETH", "SOL", "XMR", "PUMP", "XPL", "ENA"];
const res = {};
console.log(`КЕРРИ ШОРТА ПЕРПА HL, движок, конфиг B, ноциональ $${NOTIONAL.toLocaleString()}, кэш проекта`);
console.log(`период кэша: ${all.get("BTC")[0].ts} .. ${all.get("BTC").at(-1).ts} (${all.get("BTC").length} часов)`);
console.log("\nмонета".padEnd(9) + "часов".padStart(7) + "керри $".padStart(12) + "годовых".padStart(10) + "  |  1-я половина    2-я половина  доля часов f=i");

for (const t of wanted) {
  const rows = rowsOf(t); if (!rows) { console.log(t.padEnd(9) + "  нет в кэше"); continue; }
  const H = Math.floor(rows.length / 2);
  const c = carry(rows), h1 = carry(rows.slice(0, H)), h2 = carry(rows.slice(H));
  const iShare = rows.filter((r) => Math.abs(r.hl_rate - 1.25e-5) < 1e-12).length / rows.length;
  res[t] = { full: c, h1, h2, iShare, hours: rows.length };
  const P = (x) => (x ? (x.apr * 100).toFixed(2).padStart(8) + "%" : "      нет");
  console.log(`${t.padEnd(9)}${String(rows.length).padStart(7)}${c.hl.toFixed(0).padStart(12)}${(c.apr * 100).toFixed(2).padStart(9)}%  |  ${P(h1)}      ${P(h2)}     ${(iShare * 100).toFixed(1)}%`);

}
// весь кэш для контекста
const univ = [];
for (const [t, rows] of all) { if (rows.length !== YEAR) continue; const c = carry(rows); if (c) univ.push({ t, apr: c.apr, hl: c.hl }); }
univ.sort((a, b) => b.apr - a.apr);
const med = univ.map(u => u.apr).sort((a, b) => a - b)[Math.floor(univ.length / 2)];
console.log(`\nдля контекста, все ${univ.length} монет кэша с полным годом: медиана керри ${(med * 100).toFixed(2)}% годовых`);
console.log("топ-10 по керри: " + univ.slice(0, 10).map(u => `${u.t} ${(u.apr * 100).toFixed(1)}%`).join(", "));
fs.writeFileSync(`${SP}/bas-v-carry.json`, JSON.stringify({ NOTIONAL, res, univ }, null, 1));
