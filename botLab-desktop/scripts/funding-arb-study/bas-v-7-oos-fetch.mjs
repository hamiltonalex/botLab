// В7. Вне выборки. Кэш кончается 2026-06-20; живая история ставок HL тянется до сегодня.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
const post = async (b) => { for (let i = 0; i < 5; i++) { try { const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); if (r.ok) return r.json(); } catch {} await new Promise(s => setTimeout(s, 700 * (i + 1))); } return null; };
const COINS = ["HYPE", "ZEC", "BTC", "ETH", "SOL", "XMR", "PUMP", "XPL", "ENA"];
const START = Date.parse("2026-06-20T07:00:00Z"); const END = Date.now();
const out = {};
for (const c of COINS) {
  let t = START, rows = [], guard = 0;
  while (t < END - 2 * 3600e3 && guard++ < 60) {
    const r = await post({ type: "fundingHistory", coin: c, startTime: t, endTime: END });
    await new Promise((s) => setTimeout(s, 250));
    if (!r || !r.length) break;
    rows.push(...r);
    const last = r[r.length - 1].time;
    if (last <= t) break;
    t = last + 1;
  }
  const seen = new Map(); for (const r of rows) seen.set(r.time, r);
  out[c] = [...seen.values()].sort((a, b) => a.time - b.time);
  console.log(c, out[c].length, "часов", out[c].length ? new Date(out[c][0].time).toISOString() + " .. " + new Date(out[c].at(-1).time).toISOString() : "ПУСТО");
}
fs.writeFileSync(`${SP}/bas-v-oos.json`, JSON.stringify(out));
