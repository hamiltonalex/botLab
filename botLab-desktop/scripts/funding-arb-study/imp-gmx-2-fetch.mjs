import fs from "node:fs";
import { SP, T0, T1, URL_ARB, E30, gql, marketMap } from "./imp-gmx-lib.mjs";

const EDGES = [0, 1e3, 5e3, 20e3, 50e3, 200e3, Infinity];       // границы корзин, USD
const BIG_FROM = 50e3;      // от этой величины забираем ВСЕ сделки, без выборки
const SAMPLE_MAX = 25000;   // потолок выборки на рынок для мелких корзин
const OUT = `${SP}/imp-raw`;
fs.mkdirSync(OUT, { recursive: true });

const e30 = (usd) => (usd === Infinity ? null : BigInt(Math.round(usd)) * 10n ** 30n);
const FIELDS = "id timestamp orderType sizeDeltaUsd priceImpactUsd totalImpactUsd isLong";
const where = (addr, extra = "", fromTs = T0) =>
  `{ marketAddress_eq: "${addr}", eventName_eq: "OrderExecuted", sizeDeltaUsd_gt: "0", timestamp_gte: ${fromTs}, timestamp_lte: ${T1}${extra} }`;

// ---- точные счётчики по корзинам и стороне: все алиасы одним запросом ----
async function exactCounts(addr) {
  const parts = [];
  for (let b = 0; b < EDGES.length - 1; b++)
    for (const L of [true, false]) {
      const lo = `, sizeDeltaUsd_gte: "${e30(EDGES[b])}"`;
      const hi = EDGES[b + 1] === Infinity ? "" : `, sizeDeltaUsd_lt: "${e30(EDGES[b + 1])}"`;
      parts.push(`b${b}_${L ? "L" : "S"}: tradeActionsConnection(orderBy: timestamp_ASC, where: ${where(addr, `${lo}${hi}, isLong_eq: ${L}`)}) { totalCount }`);
    }
  parts.push(`all: tradeActionsConnection(orderBy: timestamp_ASC, where: ${where(addr)}) { totalCount }`);
  const d = await gql(URL_ARB, `{ ${parts.join(" ")} }`);
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.totalCount]));
}

// ---- страница ----
async function page(addr, fromTs, extra = "") {
  const d = await gql(URL_ARB, `{ tradeActions(limit: 1000, orderBy: timestamp_ASC, where: ${where(addr, extra, fromTs)}) { ${FIELDS} } }`);
  return d.tradeActions;
}
// курсор по timestamp_gte + дедуп по id (равные секунды не теряются)
async function crawl(addr, fromTs, maxRows, extra = "") {
  const seen = new Set(); const rows = []; let cur = fromTs; let pages = 0;
  while (rows.length < maxRows) {
    const b = await page(addr, cur, extra); pages++;
    if (!b.length) break;
    let added = 0;
    for (const r of b) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); added++; }
    if (b.length < 1000) break;
    const last = b[b.length - 1].timestamp;
    cur = last === cur && added === 0 ? cur + 1 : last;   // защита от залипания на одной секунде
    if (pages > 400) break;
  }
  return { rows, pages, exhausted: rows.length < maxRows };
}

const rnd = (() => { let s = 20260830; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();

const pack = (r) => [r.timestamp, r.orderType, r.isLong ? 1 : 0,
  Number(r.sizeDeltaUsd) / E30, Number(r.priceImpactUsd) / E30,
  r.totalImpactUsd == null ? null : Number(r.totalImpactUsd) / E30];

const M = marketMap();
const c63 = JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8"));
const counts = JSON.parse(fs.readFileSync(`${SP}/imp-counts.json`, "utf8"));
const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;

for (const rec of c63) {
  const t = rec.t; if (only && !only.has(t)) continue;
  const dst = `${OUT}/${t}.json`;
  if (fs.existsSync(dst)) { console.log(`${t.padEnd(10)} уже есть`); continue; }
  const addr = M.get(t).addr, N = counts[t];
  const cnt = await exactCounts(addr);

  // ВСЕ крупные сделки (>= $50k) без выборки
  const big = await crawl(addr, T0, 60000, `, sizeDeltaUsd_gte: "${e30(BIG_FROM)}"`);

  // представительная выборка: полный обход, если умещается, иначе случайные якоря
  let sample, mode;
  if (N <= SAMPLE_MAX) { const c = await crawl(addr, T0, SAMPLE_MAX); sample = c.rows; mode = "full"; }
  else {
    mode = "anchors";
    const K = Math.ceil(SAMPLE_MAX / 1000); const seen = new Set(); sample = [];
    for (let k = 0; k < K; k++) {
      const a = T0 + Math.floor(rnd() * (T1 - T0));
      const b = await page(addr, a);
      for (const r of b) if (!seen.has(r.id)) { seen.add(r.id); sample.push(r); }
    }
  }
  const out = { t, addr, chain: "arbitrum", totalExecuted: N, counts: cnt,
    sampleMode: mode, sampleN: sample.length, bigN: big.rows.length, bigComplete: !big.exhausted ? big.rows.length < 60000 : true,
    cols: ["ts", "orderType", "isLong", "sizeUsd", "priceImpactUsd", "totalImpactUsd"],
    big: big.rows.map(pack), sample: sample.map(pack) };
  fs.writeFileSync(dst, JSON.stringify(out));
  console.log(`${t.padEnd(10)} всего=${String(N).padStart(7)} выборка=${String(sample.length).padStart(6)}(${mode}) крупных>=50k=${String(big.rows.length).padStart(6)}`);
}
console.log("ГОТОВО");
