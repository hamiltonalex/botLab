// В9. БАЗИС СПОТ-ПЕРП. В данных проекта его нет; берём свечи обеих книг живьём.
// Это не украшение: конструкцию открывают и закрывают по РАЗНОМУ базису, и разница базисов
// входа и выхода - такая же издержка, как комиссия.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
const post = async (b) => { for (let i = 0; i < 4; i++) { try { const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); if (r.ok) return r.json(); } catch {} await new Promise(s => setTimeout(s, 600)); } return null; };
const { pairs } = JSON.parse(fs.readFileSync(`${SP}/bas-v-pairs.json`, "utf8"));
const END = Date.now(), START = END - 5000 * 3600e3;
const out = {};
for (const p of pairs) {
  const cand = async (coin) => { for (let k = 0; k < 6; k++) { const r = await post({ type: "candleSnapshot", req: { coin, interval: "1h", startTime: START, endTime: END } }); if (r?.length) return r; await new Promise(s => setTimeout(s, 1500 * (k + 1))); } return null; };
  const cs = await cand(p.wire); await new Promise(s => setTimeout(s, 500));
  const cp = await cand(p.perp); await new Promise(s => setTimeout(s, 500));
  if (!cs?.length || !cp?.length) { console.log(p.perp, "нет свечей", cs?.length, cp?.length); continue; }
  const sp = new Map(cs.map((c) => [c.t, Number(c.c)])), pp = new Map(cp.map((c) => [c.t, Number(c.c)]));
  const rows = [];
  for (const [t, s] of sp) { const q = pp.get(t); if (q > 0) rows.push({ t, s, q, b: (s - q) / q }); }
  rows.sort((a, b) => a.t - b.t);
  out[p.perp] = { wire: p.wire, n: rows.length, from: rows[0]?.t, to: rows.at(-1)?.t, rows };
  const bs = rows.map((r) => r.b * 1e4).sort((a, b) => a - b);
  const q = (f) => bs[Math.floor(f * (bs.length - 1))];
  const mean = bs.reduce((a, x) => a + x, 0) / bs.length;
  const sd = Math.sqrt(bs.reduce((a, x) => a + (x - mean) ** 2, 0) / bs.length);
  out[p.perp].stat = { n: bs.length, mean, sd, p01: q(0.01), p05: q(0.05), p50: q(0.5), p95: q(0.95), p99: q(0.99), min: bs[0], max: bs.at(-1) };
}
fs.writeFileSync(`${SP}/bas-v-basis.json`, JSON.stringify(out));
console.log(`БАЗИС (спот - перп)/перп, часовые закрытия, до ${new Date(END).toISOString().slice(0, 10)}, в базисных пунктах:`);
console.log("актив".padEnd(8) + "часов".padStart(7) + "средн".padStart(8) + "медиана".padStart(9) + "сигма".padStart(8) + "p01".padStart(9) + "p99".padStart(9) + "мин".padStart(10) + "макс".padStart(9));
for (const [k, v] of Object.entries(out)) { const s = v.stat;
  console.log(k.padEnd(8) + String(s.n).padStart(7) + s.mean.toFixed(1).padStart(8) + s.p50.toFixed(1).padStart(9) + s.sd.toFixed(1).padStart(8) + s.p01.toFixed(1).padStart(9) + s.p99.toFixed(1).padStart(9) + s.min.toFixed(0).padStart(10) + s.max.toFixed(0).padStart(9)); }
