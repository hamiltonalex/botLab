// В4. Живые стаканы ОБЕИХ ног. Несколько снимков подряд, чтобы один тонкий момент не решал всё.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
const post = async (b) => { for (let i = 0; i < 4; i++) { try { const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); if (r.ok) return r.json(); } catch {} await new Promise(s => setTimeout(s, 400)); } return null; };
const { pairs } = JSON.parse(fs.readFileSync(`${SP}/bas-v-pairs.json`, "utf8"));
const SNAPS = Number(process.argv[2] || 5), GAP_MS = Number(process.argv[3] || 20000);
const out = [];
for (let s = 0; s < SNAPS; s++) {
  const snap = { t: Date.now(), spot: {}, perp: {} };
  for (const p of pairs) {
    snap.spot[p.perp] = await post({ type: "l2Book", coin: p.wire });
    snap.perp[p.perp] = await post({ type: "l2Book", coin: p.perp });
  }
  out.push(snap);
  process.stderr.write(`снимок ${s + 1}/${SNAPS}\n`);
  if (s < SNAPS - 1) await new Promise(r => setTimeout(r, GAP_MS));
}
fs.writeFileSync(`${SP}/bas-v-books.json`, JSON.stringify(out));
const b0 = out[0];
console.log("глубина книг в первом снимке (уровней / видимый ноциональ каждой стороны):");
console.log("актив".padEnd(8) + "  СПОТ bid ур/$".padEnd(22) + "СПОТ ask ур/$".padEnd(22) + "ПЕРП bid ур/$".padEnd(22) + "ПЕРП ask ур/$");
const side = (bk, i) => { const L = bk?.levels?.[i] || []; return [L.length, L.reduce((a, l) => a + Number(l.px) * Number(l.sz), 0)]; };
for (const p of pairs) {
  const f = (bk, i) => { const [n, v] = side(bk, i); return `${String(n).padStart(3)} / $${(v / 1e6).toFixed(3)}M`.padEnd(22); };
  console.log(p.perp.padEnd(8) + "  " + f(b0.spot[p.perp], 0) + f(b0.spot[p.perp], 1) + f(b0.perp[p.perp], 0) + f(b0.perp[p.perp], 1));
}
