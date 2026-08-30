// Устойчивость бюджета опроса HL: 6 полных срезов за минуту, потом жёсткая очередь без пауз.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const S = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
const cap = JSON.parse(fs.readFileSync(`${S}/cap63.json`, "utf8"));
const coins = [...cap].sort((a, b) => b.hlOi - a.hlOi).slice(0, 25).map((r) => r.coin);
let n429 = 0, nReq = 0;
async function post(body) {
  nReq++;
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 429) { n429++; return null; }
  return r.json();
}
async function slice(conc) {
  const t0 = Date.now();
  const q = [...coins];
  const metaP = post({ type: "metaAndAssetCtxs" });
  const w = async () => { for (;;) { const c = q.shift(); if (!c) return; await post({ type: "l2Book", coin: c }); } };
  await Promise.all([metaP, ...[...Array(conc)].map(w)]);
  return Date.now() - t0;
}
console.log("режим 1: срез каждые 10 с в течение минуты (конкурентность 4)");
const t0 = Date.now();
for (let i = 0; i < 6; i++) {
  const ms = await slice(4);
  console.log(`  срез ${i + 1}: ${ms} мс, накоплено запросов ${nReq}, 429=${n429}`);
  const wait = 10000 - ms;
  if (wait > 0 && i < 5) await new Promise((r) => setTimeout(r, wait));
}
console.log(`итог режима 1: ${nReq} запросов за ${((Date.now() - t0) / 1000).toFixed(1)} с, 429=${n429}`);

console.log("\nрежим 2: 4 среза подряд без пауз, конкурентность 8 (проверка потолка)");
const b0 = n429, r0 = nReq, tb = Date.now();
for (let i = 0; i < 4; i++) { const ms = await slice(8); console.log(`  срез ${i + 1}: ${ms} мс, 429 всего=${n429}`); }
console.log(`итог режима 2: ${nReq - r0} запросов за ${((Date.now() - tb) / 1000).toFixed(1)} с, 429 за режим=${n429 - b0}`);
console.log(`ВСЕГО: ${nReq} запросов, 429: ${n429}`);
