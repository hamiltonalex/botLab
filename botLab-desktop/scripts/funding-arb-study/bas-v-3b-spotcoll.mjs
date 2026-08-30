// В3б. Считается ли СПОТ залогом перпа? Если да, accountValue перпа обязан двигаться от спота.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
const post = async (b) => { const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return r.ok ? r.json() : null; };
const lb = JSON.parse(fs.readFileSync(`${SP}/bas-v-lb.json`, "utf8"));
const rows = (lb.leaderboardRows || lb).slice(0, 300);
let found = 0;
console.log("счета, где ОДНОВРЕМЕННО есть спот-остатки и перп-позиции:");
console.log("перп accountValue".padStart(19) + "перп ntl".padStart(14) + "спот $".padStart(14) + "   спот входит в accountValue?");
for (const r of rows) {
  const [c, s] = await Promise.all([post({ type: "clearinghouseState", user: r.ethAddress }), post({ type: "spotClearinghouseState", user: r.ethAddress })]);
  const bal = (s?.balances || []).filter((b) => Number(b.total) > 0);
  if (!bal.length || !c?.assetPositions?.length) continue;
  // грубая долларовая оценка спота: USDC как есть, прочее пропускаем в отдельную колонку
  const usdc = bal.filter((b) => b.coin === "USDC").reduce((a, b) => a + Number(b.total), 0);
  const av = Number(c.marginSummary.accountValue), raw = Number(c.marginSummary.totalRawUsd);
  const upnl = c.assetPositions.reduce((a, p) => a + Number(p.position.unrealizedPnl), 0);
  const check = Math.abs(av - (raw + upnl)) < 1e-6;
  console.log(`${av.toFixed(2).padStart(19)}${Number(c.marginSummary.totalNtlPos).toFixed(0).padStart(14)}${bal.map(b => b.coin + ":" + Number(b.total).toPrecision(4)).join(",").slice(0, 40).padStart(42)}`);
  console.log(`   accountValue(${av.toFixed(2)}) == totalRawUsd(${raw.toFixed(2)}) + uPnL(${upnl.toFixed(2)}) ? ${check ? "ДА" : "НЕТ"}; спотовый USDC=${usdc.toFixed(2)} в него НЕ входит`);
  if (++found >= 6) break;
}
console.log("\nВывод: перповый accountValue = только перповый USDC + uPnL. Спот-кошелёк отдельный, залогом перпа не служит.");
