// В3. Механика маржи HL, подтверждённая ответами API (а не только текстом документации).
// Ищем счета с ОДНОЙ позицией: на них поддерживающая маржа читается напрямую.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
const post = async (b) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); if (r.ok) return r.json(); } catch {} await new Promise(s => setTimeout(s, 500)); } return null; };
const d = JSON.parse(fs.readFileSync(`${SP}/bas-v-hl.json`, "utf8"));
const mx = new Map(d.meta.universe.map((u) => [u.name, u.maxLeverage]));
const lb = JSON.parse(fs.readFileSync(`${SP}/bas-v-lb.json`, "utf8"));
const rows = (lb.leaderboardRows || lb);
const addrs = rows.slice(0, 400).map((r) => r.ethAddress);
const single = [], spotAsCollateral = [];
for (let i = 0; i < addrs.length; i++) {
  const c = await post({ type: "clearinghouseState", user: addrs[i] });
  if (!c?.assetPositions?.length) continue;
  const ntl = c.assetPositions.reduce((s, p) => s + Number(p.position.positionValue), 0);
  const mm = Number(c.crossMaintenanceMarginUsed);
  if (c.assetPositions.length === 1) {
    const P = c.assetPositions[0].position, L = mx.get(P.coin);
    single.push({ u: addrs[i], coin: P.coin, ntl: Number(P.positionValue), mm, maxLev: L,
      frac: mm / Number(P.positionValue), iso: c.assetPositions[0].position.leverage.type });
  }
  // Учитывается ли спот в марже перпа? Сравним accountValue перпа с totalRawUsd + unrealized.
  if (single.length >= 25) break;
  if (i % 50 === 49) process.stderr.write(".");
}
console.log("\nСЧЕТА С ОДНОЙ ПОЗИЦИЕЙ: поддерживающая маржа / ноциональ против 1/(2*maxLev):");
console.log("монета".padEnd(9) + "maxLev".padStart(7) + "ноциональ".padStart(14) + "MM факт".padStart(12) + "MM/ntl".padStart(9) + "1/(2L)".padStart(9) + "  режим");
for (const s of single) console.log(`${s.coin.padEnd(9)}${String(s.maxLev).padStart(6)}x $${s.ntl.toFixed(0).padStart(12)}${s.mm.toFixed(2).padStart(12)}${(s.frac * 100).toFixed(3).padStart(8)}%${(100 / (2 * s.maxLev)).toFixed(3).padStart(8)}%  ${s.iso}`);
const cross = single.filter((s) => s.iso === "cross");
const ok = cross.filter((s) => Math.abs(s.frac - 1 / (2 * s.maxLev)) < 1e-4).length;
console.log(`\nправило MM = 1/(2*maxLeverage) подтверждается на ${ok} из ${cross.length} кросс-счетов с одной позицией`);
fs.writeFileSync(`${SP}/bas-v-margin.json`, JSON.stringify({ single }, null, 1));
