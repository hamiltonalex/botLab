// В11. Насколько высоко цена уходит за срок удержания. Это и задаёт буфер маржи короткой ноги:
// перп теряет на росте, а прибыль спота лежит в ДРУГОМ кошельке и маржой перпа не служит
// (в обычном режиме счёта).
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
const post = async (b) => { for (let i = 0; i < 5; i++) { try { const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); if (r.ok) { const j = await r.json(); if (j?.length) return j; } } catch {} await new Promise(s => setTimeout(s, 1200 * (i + 1))); } return null; };
const COINS = ["HYPE", "BTC", "ETH", "SOL", "ZEC", "XMR", "PUMP", "XPL", "ENA"];
const END = Date.now(), START = END - 1200 * 86400e3;
const HOLD = [365, 91, 30, 14]; // суток на удержание при 1 / 4 / 12 / 26 перезаходах в год
const out = {};
console.log("МАКСИМАЛЬНЫЙ РОСТ ЦЕНЫ ВНУТРИ СРОКА УДЕРЖАНИЯ (дневные свечи, high против цены входа):");
console.log("монета".padEnd(8) + "суток" .padStart(6) + "   " + HOLD.map(h => `${h}д: медиана/p95/макс`.padStart(24)).join(""));
for (const c of COINS) {
  const k = await post({ type: "candleSnapshot", req: { coin: c, interval: "1d", startTime: START, endTime: END } });
  if (!k) { console.log(c, "нет свечей"); continue; }
  const px = k.map(x => ({ t: x.t, o: Number(x.o), h: Number(x.h), l: Number(x.l), c: Number(x.c) }));
  const row = { n: px.length, from: new Date(px[0].t).toISOString().slice(0, 10), byHold: {} };
  const cells = [];
  for (const H of HOLD) {
    const ups = [];
    for (let i = 0; i + 1 < px.length; i++) {
      const end = Math.min(px.length, i + H);
      let mx = 0; for (let j = i; j < end; j++) mx = Math.max(mx, px[j].h / px[i].o - 1);
      if (end - i >= Math.min(H, 7)) ups.push(mx);
    }
    ups.sort((a, b) => a - b);
    const q = (f) => ups[Math.floor(f * (ups.length - 1))];
    row.byHold[H] = { n: ups.length, p50: q(0.5), p95: q(0.95), max: ups.at(-1) };
    cells.push(`${(q(0.5) * 100).toFixed(0)}/${(q(0.95) * 100).toFixed(0)}/${(ups.at(-1) * 100).toFixed(0)}%`.padStart(24));
  }
  out[c] = row;
  console.log(c.padEnd(8) + String(px.length).padStart(6) + "   " + cells.join(""));
}
fs.writeFileSync(`${SP}/bas-v-drawup.json`, JSON.stringify(out, null, 1));
