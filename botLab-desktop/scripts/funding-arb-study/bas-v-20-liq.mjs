// В20. Как часто конструкция была бы ЛИКВИДИРОВАНА. Порог роста цены берём из модели
// портфельной маржи (HYPE +339%, BTC +280% при нулевом буфере USDC).
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
const post = async (b) => { for (let i = 0; i < 5; i++) { try { const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); if (r.ok) { const j = await r.json(); if (j?.length) return j; } } catch {} await new Promise(s => setTimeout(s, 1200)); } return null; };
const TH = { HYPE: 4.393, BTC: 3.800 };
const BUF = [0, 0.15, 0.30, 0.50];
const HOLD = { 1: 365, 4: 91, 12: 30, 26: 14 };
for (const [t, x0] of Object.entries(TH)) {
  const k = await post({ type: "candleSnapshot", req: { coin: t, interval: "1d", startTime: Date.now() - 1200 * 86400e3, endTime: Date.now() } });
  const px = k.map((x) => ({ t: x.t, o: +x.o, h: +x.h }));
  console.log(`\n${t}: порог ликвидации при буфере USDC b -> цена x${x0.toFixed(2)}*(1+b) от входа. Свечей ${px.length}, с ${new Date(px[0].t).toISOString().slice(0, 10)}`);
  console.log("буфер USDC".padEnd(12) + "капитал/ноц".padStart(12) + "порог роста".padStart(13) + "  доля входов, кончившихся ликвидацией, по сроку удержания:");
  console.log("".padEnd(37) + Object.entries(HOLD).map(([kk, h]) => `${kk}/год (${h}д)`.padStart(15)).join(""));
  for (const b of BUF) {
    const th = x0 * (1 + b);
    const cells = Object.values(HOLD).map((H) => {
      let n = 0, hit = 0;
      for (let i = 0; i + Math.min(H, 7) < px.length; i++) { const e = Math.min(px.length, i + H); let mx = 0;
        for (let j = i; j < e; j++) mx = Math.max(mx, px[j].h / px[i].o); n++; if (mx >= th) hit++; }
      return `${(hit / n * 100).toFixed(1)}% (${hit}/${n})`.padStart(15);
    });
    console.log(`b = ${(b * 100).toFixed(0)}%`.padEnd(12) + (1 + b).toFixed(2).padStart(12) + `+${((th - 1) * 100).toFixed(0)}%`.padStart(13) + "  " + cells.join(""));
  }
}
