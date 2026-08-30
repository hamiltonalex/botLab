import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
const SP=STUDY_DATA, SCAN=STUDY_CACHE+"/_scan_results.csv";
import fs from "node:fs";
const E30 = 1e30;
const num = (x) => Number(x) / E30;

// 1. Мэппинг токен -> рынок GMX и монета HL, ЗАПИСАННЫЙ при сборке кэша (не переизобретаем).
const lines = fs.readFileSync(SCAN, "utf8").trim().split("\n");
const head = lines[0].split(",");
const ix = Object.fromEntries(head.map((h, i) => [h, i]));
const map = new Map();
for (const l of lines.slice(1)) {
  const p = l.split(",");
  map.set(p[ix.token], { config: p[ix.config], gmxLeg: p[ix.gmx_leg], gmxName: p[ix.gmx_name],
    gmxMarket: (p[ix.gmx_market] || "").toLowerCase(), hlCoin: p[ix.hl_coin], maxlev: Number(p[ix.hl_maxlev]) });
}

// 2. Ёмкость GMX по адресу рынка: свободная ликвидность и открытый интерес каждой стороны.
const gmx = new Map();
for (const file of ["mi.json", "mi-avax.json"]) {
  const d = JSON.parse(fs.readFileSync(`${SP}/${file}`, "utf8"));
  for (const m of d.markets ?? d) {
    gmx.set(m.marketToken.toLowerCase(), {
      name: m.name, listed: m.isListed, listing: (m.listingDate || "").slice(0, 10),
      availLong: num(m.availableLiquidityLong), availShort: num(m.availableLiquidityShort),
      oiLong: num(m.openInterestLong), oiShort: num(m.openInterestShort),
    });
  }
}

// 3. Ёмкость HL: открытый интерес монеты в долларах и суточный оборот.
const h = JSON.parse(fs.readFileSync(`${SP}/hl.json`, "utf8"));
const hl = new Map();
h[0].universe.forEach((u, i) => {
  const c = h[1][i];
  hl.set(u.name, { oiUsd: Number(c.openInterest) * Number(c.markPx), vol: Number(c.dayNtlVlm), maxlev: u.maxLeverage });
});

const MAJORS = ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC","BCH","DOT","ATOM","ARB","OP","NEAR","SUI","TRX","UNI","AAVE","XLM","TAO","FIL"];
// Брутто вклада каждого имени в прогоне W=90 H=30 N=3 (посчитано мной ранее, для взвешивания вывода).
const CONTRIB = { FIL: 258.38, OP: 85.72, TRX: 78.78, XLM: 16.26, DOT: 15.05, ADA: 13.09, BNB: 11.15, BCH: 1.04 };

console.log(`# ЁМКОСТЬ РЫНКОВ, снимок ${new Date().toISOString().slice(0, 10)} (GMX Arbitrum+Avalanche, Hyperliquid)\n`);
console.log(`ВНИМАНИЕ: это ёмкость СЕГОДНЯ, а не в период прогона 2025-06..2026-06. Она отвечает на вопрос`);
console.log(`«можно ли войти этим размером сейчас», а не «можно ли было тогда».\n`);
console.log(`| токен | рынок GMX | сторона | свободно GMX $ | OI GMX $ | OI HL $ | оборот HL/сут $ | вклад в брутто $ |`);
console.log(`|---|---|---|---|---|---|---|---|`);
const fm = (x) => !Number.isFinite(x) ? "н/д" : x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(0)}k` : x.toFixed(0);
const rows = [];
for (const t of MAJORS) {
  const m = map.get(t); if (!m) { console.log(`| ${t} | НЕТ В МЭППИНГЕ | | | | | | |`); continue; }
  const g = gmx.get(m.gmxMarket);
  const H = hl.get(m.hlCoin);
  // Конфиг A = шорт GMX + лонг HL; B = лонг GMX + шорт HL. Свободная ликвидность нужна на своей стороне.
  const side = m.gmxLeg === "short" ? "шорт GMX" : "лонг GMX";
  const avail = !g ? NaN : (m.gmxLeg === "short" ? g.availShort : g.availLong);
  const oi = !g ? NaN : (m.gmxLeg === "short" ? g.oiShort : g.oiLong);
  rows.push({ t, name: g?.name ?? "?", side, avail, oi, hlOi: H?.oiUsd ?? NaN, hlVol: H?.vol ?? NaN, contrib: CONTRIB[t] ?? 0, listed: g?.listed });
  console.log(`| ${t} | ${g?.name ?? "рынка нет"} | ${side} | ${fm(avail)} | ${fm(oi)} | ${fm(H?.oiUsd)} | ${fm(H?.vol)} | ${CONTRIB[t] ? CONTRIB[t].toFixed(0) : "-"} |`);
}

// 4. Порог: сколько позиций размера X помещается в свободную ликвидность узкой стороны.
console.log(`\n# СКОЛЬКО ПОЗИЦИЙ ПОМЕЩАЕТСЯ (узкое место = min(свободно GMX, 1% суточного оборота HL))\n`);
console.log(`| токен | узкое место $ | позиций по $667 | позиций по $10k | позиций по $100k |`);
console.log(`|---|---|---|---|---|`);
for (const r of rows.sort((a, b) => b.contrib - a.contrib)) {
  const bind = Math.min(r.avail, r.hlVol * 0.01);
  console.log(`| ${r.t} | ${fm(bind)} | ${Math.floor(bind / 667)} | ${Math.floor(bind / 10000)} | ${Math.floor(bind / 100000)} |`);
}
fs.writeFileSync(`${SP}/capacity.json`, JSON.stringify(rows, null, 1));
