// Бюджет опроса Hyperliquid: metaAndAssetCtxs + 25 стаканов, время и свежесть.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const S = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
const cap = JSON.parse(fs.readFileSync(`${S}/cap63.json`, "utf8"));
const top = [...cap].sort((a, b) => b.hlOi - a.hlOi).slice(0, 25);
const coins = top.map((r) => r.coin);
console.log("25 монет:", coins.join(" "));

let n429 = 0, nReq = 0;
async function post(body) {
  nReq++;
  const t0 = Date.now();
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 429) { n429++; return { ms: Date.now() - t0, status: 429, j: null, bytes: 0 }; }
  const txt = await r.text();
  return { ms: Date.now() - t0, status: r.status, j: JSON.parse(txt), bytes: txt.length };
}

// --- 1. metaAndAssetCtxs ---
const lat = [];
let meta1 = null;
for (let i = 0; i < 3; i++) {
  const res = await post({ type: "metaAndAssetCtxs" });
  lat.push(res.ms);
  meta1 = res;
  await new Promise((r) => setTimeout(r, 300));
}
const [meta, ctxs] = meta1.j;
console.log(`\nmetaAndAssetCtxs: ${meta.universe.length} монет, ${(meta1.bytes / 1024).toFixed(0)} КиБ, задержки ${lat.join("/")} мс`);
const iETH = meta.universe.findIndex((u) => u.name === "ETH");
console.log("поля ctx:", Object.keys(ctxs[iETH]).join(", "));
console.log("ETH ctx:", JSON.stringify(ctxs[iETH]));

// --- 2. 25 стаканов последовательно ---
const tSeq0 = Date.now();
const seqMs = [], ages = [];
const nowMs = () => Date.now();
for (const c of coins) {
  const res = await post({ type: "l2Book", coin: c });
  seqMs.push(res.ms);
  if (res.j && res.j.time) ages.push(nowMs() - res.j.time);
}
const tSeq = Date.now() - tSeq0;
seqMs.sort((a, b) => a - b);
console.log(`\n25 стаканов последовательно: ${tSeq} мс всего, на запрос med=${seqMs[12]} p90=${seqMs[22]} max=${seqMs[24]} мс, 429=${n429}`);
console.log(`возраст стакана (локальные часы - book.time): med=${ages.sort((a,b)=>a-b)[Math.floor(ages.length/2)]} мс, max=${ages[ages.length-1]} мс`);

// --- 3. 25 стаканов с конкурентностью 5 ---
await new Promise((r) => setTimeout(r, 1000));
const before429 = n429;
const tPar0 = Date.now();
const queue = [...coins];
const parMs = [];
async function worker() { for (;;) { const c = queue.shift(); if (!c) return; const res = await post({ type: "l2Book", coin: c }); parMs.push(res.ms); } }
await Promise.all([...Array(5)].map(worker));
const tPar = Date.now() - tPar0;
console.log(`25 стаканов при конкурентности 5: ${tPar} мс всего, 429 за проход=${n429 - before429}`);

// --- 4. полный живой срез: GMX + HL мета + 25 стаканов ---
await new Promise((r) => setTimeout(r, 1000));
const tAll0 = Date.now();
const stamps = {};
const gmxP = fetch("https://arbitrum-api.gmxinfra.io/markets/info").then(async (r) => { const t = await r.text(); stamps.gmx = Date.now() - tAll0; return t.length; });
const metaP = post({ type: "metaAndAssetCtxs" }).then((r) => { stamps.meta = Date.now() - tAll0; return r; });
const q2 = [...coins];
const bookDone = [];
async function w2() { for (;;) { const c = q2.shift(); if (!c) return; const r = await post({ type: "l2Book", coin: c }); bookDone.push({ c, at: Date.now() - tAll0, t: r.j?.time }); } }
const [gmxBytes] = await Promise.all([gmxP, metaP, ...[...Array(4)].map(w2)]);
const tAll = Date.now() - tAll0;
const oldest = Math.min(...bookDone.map((b) => b.t).filter(Boolean));
console.log(`\nПОЛНЫЙ СРЕЗ (markets/info + metaAndAssetCtxs + 25 стаканов, конкурентность 4 на HL):`);
console.log(`  всего ${tAll} мс; markets/info пришёл на ${stamps.gmx} мс (${(gmxBytes/1024).toFixed(0)} КиБ), мета на ${stamps.meta} мс`);
console.log(`  первый стакан на ${Math.min(...bookDone.map(b=>b.at))} мс, последний на ${Math.max(...bookDone.map(b=>b.at))} мс`);
console.log(`  разброс возраста данных внутри среза: ${Date.now() - oldest} мс от самого старого стакана`);
console.log(`\nвсего HTTP-запросов к HL за прогон: ${nReq}, из них 429: ${n429}`);
