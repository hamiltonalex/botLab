// Достаточен ли ЖИВОЙ стакан (20 уровней, полная точность) на рабочем диапазоне размеров.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const S = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
const cap = JSON.parse(fs.readFileSync(`${S}/cap63.json`, "utf8"));
const coins = [...cap].sort((a, b) => b.hlOi - a.hlOi).slice(0, 25).map((r) => r.coin);
const post = async (b) => (await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();
const SIZES = [3162, 10000, 25000, 50000];
const fill = (lv, mid, x) => {
  let need = x, spent = 0, got = 0;
  for (const [p, z] of lv) { const take = Math.min(need, p * z); spent += take; got += take / p; need -= take; if (need <= 1e-9) break; }
  if (need > 1e-9) return null;
  return Math.abs(spent / got - mid) / mid * 1e4;
};
const out = [];
for (const coin of coins) {
  const b = await post({ type: "l2Book", coin });
  const bids = b.levels[0].map((l) => [Number(l.px), Number(l.sz)]);
  const asks = b.levels[1].map((l) => [Number(l.px), Number(l.sz)]);
  const mid = (bids[0][0] + asks[0][0]) / 2;
  const visB = asks.reduce((s, [p, z]) => s + p * z, 0), visS = bids.reduce((s, [p, z]) => s + p * z, 0);
  const row = { coin, nLv: asks.length, visB, visS, buy: SIZES.map((x) => fill(asks, mid, x)), sell: SIZES.map((x) => fill(bids, mid, x)) };
  out.push(row);
  await new Promise((r) => setTimeout(r, 60));
}
console.log("монета  уровней  видимый ask/bid    круг (buy+sell) в б.п. на $3162 / $10k / $25k / $50k");
let okAt = [0, 0, 0, 0];
for (const r of out) {
  const rt = r.buy.map((v, i) => (v === null || r.sell[i] === null) ? null : v + r.sell[i]);
  rt.forEach((v, i) => { if (v !== null) okAt[i]++; });
  console.log(`${r.coin.padEnd(9)} ${String(r.nLv).padEnd(7)} $${(r.visB/1e3).toFixed(0)}k/$${(r.visS/1e3).toFixed(0)}k`.padEnd(38) + rt.map((v) => v === null ? "нет глубины" : v.toFixed(2)).join(" / "));
}
console.log(`\nиз 25 монет живой стакан покрывает круг: $3162 у ${okAt[0]}, $10k у ${okAt[1]}, $25k у ${okAt[2]}, $50k у ${okAt[3]}`);
const visAll = out.map((r) => Math.min(r.visB, r.visS)).sort((a, b) => a - b);
console.log(`видимый объём (минимум из сторон): мин=$${(visAll[0]/1e3).toFixed(0)}k медиана=$${(visAll[12]/1e3).toFixed(0)}k макс=$${(visAll[24]/1e3).toFixed(0)}k`);
