// Суточные обороты HL за САМ период прогона по всем 63 именам (свечи 1d).
import fs from "node:fs";
import { SP } from "./skept-cap-lib.mjs";
const cap = JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8"));
const have = fs.existsSync(`${SP}/vol63.json`) ? JSON.parse(fs.readFileSync(`${SP}/vol63.json`, "utf8")) : {};
const S = 1750402800000, E = 1781938800000;
let n = 0, bad = [];
for (const r of cap) {
  if (have[r.t] !== undefined) continue;
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: r.coin, interval: "1d", startTime: S, endTime: E } }) });
    const j = await res.json();
    have[r.t] = Array.isArray(j) && j.length ? j.map((c) => ({ t: c.t, ntl: Number(c.v) * Number(c.c) })) : null;
    if (!have[r.t]) bad.push(r.t);
  } catch (e) { have[r.t] = null; bad.push(`${r.t}(${String(e).slice(0,40)})`); }
  n++;
  await new Promise((x) => setTimeout(x, 130));
}
fs.writeFileSync(`${SP}/vol63.json`, JSON.stringify(have));
const withData = Object.entries(have).filter(([, v]) => v && v.length).length;
console.log(`скачано ${n}, с данными ${withData} из ${cap.length}, без свечей: ${bad.join(", ") || "нет"}`);
const med = (xs) => { const a = xs.slice().sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length-1)/2] : (a[a.length/2-1]+a[a.length/2])/2) : NaN; };
const ratios = [];
for (const r of cap) { const c = have[r.t]; if (!c || !c.length) continue;
  const m = med(c.map((x) => x.ntl).filter(Number.isFinite)); if (m > 0) ratios.push(r.hlVolSnap / m); }
console.log(`отношение снимок/медиана периода: медиана ${med(ratios).toFixed(2)}x по ${ratios.length} именам`);
