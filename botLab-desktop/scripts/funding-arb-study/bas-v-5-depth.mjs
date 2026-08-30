// В5. Стаканы обеих ног на трёх разрешениях, сшитые в одну лестницу.
// l2Book отдаёт не более 20 уровней; на тонком споте это обрывается на ~$0.13M, поэтому
// тонкую книгу продолжаем агрегированной (nSigFigs 4, затем 3) строго за её последней ценой.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
const post = async (b) => { for (let i = 0; i < 4; i++) { try { const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); if (r.ok) return r.json(); } catch {} await new Promise(s => setTimeout(s, 400)); } return null; };
const { pairs } = JSON.parse(fs.readFileSync(`${SP}/bas-v-pairs.json`, "utf8"));
const SNAPS = Number(process.argv[2] || 4), GAP_MS = Number(process.argv[3] || 45000);
const snaps = [];
for (let s = 0; s < SNAPS; s++) {
  const snap = { t: Date.now(), books: {} };
  for (const p of pairs) for (const [leg, coin] of [["spot", p.wire], ["perp", p.perp]]) {
    const k = `${p.perp}|${leg}`;
    snap.books[k] = {};
    for (const sf of [null, 4, 3]) snap.books[k][String(sf)] = await post({ type: "l2Book", coin, ...(sf ? { nSigFigs: sf } : {}) });
  }
  snaps.push(snap); fs.writeFileSync(`${SP}/bas-v-depth.json`, JSON.stringify(snaps)); process.stderr.write(`снимок ${s + 1}/${SNAPS}\n`);
  if (s < SNAPS - 1) await new Promise(r => setTimeout(r, GAP_MS));
}
fs.writeFileSync(`${SP}/bas-v-depth.json`, JSON.stringify(snaps));
console.log("снимков:", snaps.length, "книг в снимке:", Object.keys(snaps[0].books).length);
