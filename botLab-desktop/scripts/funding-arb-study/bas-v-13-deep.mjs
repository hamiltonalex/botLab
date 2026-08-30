// В13. Глубокие книги (добавлен nSigFigs 2) под поиск ПОТОЛКА конструкции.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
const post = async (b) => { for (let i = 0; i < 5; i++) { try { const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); if (r.ok) return r.json(); } catch {} await new Promise(s => setTimeout(s, 700)); } return null; };
const { pairs } = JSON.parse(fs.readFileSync(`${SP}/bas-v-pairs.json`, "utf8"));
const TOP = ["HYPE", "BTC", "ETH", "SOL", "ZEC", "XMR", "PUMP"];
const SNAPS = Number(process.argv[2] || 5), GAP = Number(process.argv[3] || 30000);
const snaps = [];
for (let s = 0; s < SNAPS; s++) {
  const snap = { t: Date.now(), books: {} };
  for (const p of pairs.filter((x) => TOP.includes(x.perp))) for (const [leg, coin] of [["spot", p.wire], ["perp", p.perp]]) {
    const k = `${p.perp}|${leg}`; snap.books[k] = {};
    for (const sf of [null, 4, 3, 2]) snap.books[k][String(sf)] = await post({ type: "l2Book", coin, ...(sf ? { nSigFigs: sf } : {}) });
  }
  snaps.push(snap); fs.writeFileSync(`${SP}/bas-v-deep.json`, JSON.stringify(snaps));
  process.stderr.write(`снимок ${s + 1}/${SNAPS}\n`);
  if (s < SNAPS - 1) await new Promise(r => setTimeout(r, GAP));
}
