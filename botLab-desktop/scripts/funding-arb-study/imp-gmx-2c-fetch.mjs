// Сбор сделок. Рынки до 25к сделок обходятся ЦЕЛИКОМ (счётчики корзин тогда точны по самим данным).
// Рынки крупнее: якорная выборка + отдельный проход по сделкам >=$50k + точные счётчики корзин запросом totalCount.
import fs from "node:fs";
import { SP, T0, T1, URL_ARB, E30, gql, marketMap } from "./imp-gmx-lib.mjs";
const EDGES = [0, 1e3, 5e3, 20e3, 50e3, 200e3, Infinity];
const BIG_FROM = 50e3, BIG_MAX = 20000, SAMPLE_MAX = 25000, CONC = 4;
const OUT = `${SP}/imp-raw`; fs.mkdirSync(OUT, { recursive: true });
const e30 = (u) => (u === Infinity ? null : BigInt(Math.round(u)) * 10n ** 30n);
const FIELDS = "id timestamp orderType sizeDeltaUsd priceImpactUsd totalImpactUsd isLong";
const where = (a, extra = "", from = T0) => `{ marketAddress_eq: "${a}", eventName_eq: "OrderExecuted", sizeDeltaUsd_gt: "0", timestamp_gte: ${from}, timestamp_lte: ${T1}${extra} }`;
const bidx = (s) => { for (let i = EDGES.length - 2; i >= 0; i--) if (s >= EDGES[i]) return i; return 0; };

async function exactCounts(addr) {
  const parts = [];
  for (let b = 0; b < 6; b++) for (const L of [true, false]) {
    const lo = `, sizeDeltaUsd_gte: "${e30(EDGES[b])}"`, hi = EDGES[b + 1] === Infinity ? "" : `, sizeDeltaUsd_lt: "${e30(EDGES[b + 1])}"`;
    parts.push(`b${b}_${L ? "L" : "S"}: tradeActionsConnection(orderBy: timestamp_ASC, where: ${where(addr, `${lo}${hi}, isLong_eq: ${L}`)}) { totalCount }`);
  }
  const d = await gql(URL_ARB, `{ ${parts.join(" ")} }`);
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.totalCount]));
}
const page = async (a, from, extra = "") => (await gql(URL_ARB, `{ tradeActions(limit: 1000, orderBy: timestamp_ASC, where: ${where(a, extra, from)}) { ${FIELDS} } }`)).tradeActions;
async function crawl(a, maxRows, extra = "", maxPages = 500) {
  const seen = new Set(); const rows = []; let cur = T0, p = 0;
  while (rows.length < maxRows && p < maxPages) {
    const b = await page(a, cur, extra); p++;
    if (!b.length) break;
    let added = 0; for (const r of b) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); added++; }
    if (b.length < 1000) break;
    const last = b[b.length - 1].timestamp; cur = last === cur && added === 0 ? cur + 1 : last;
  }
  return rows;
}
async function anchors(a, target, extra = "", seed = 20260830) {
  let s = seed; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const seen = new Set(); const rows = [];
  for (let k = 0; k < Math.ceil(target / 1000); k++) { const b = await page(a, T0 + Math.floor(rnd() * (T1 - T0)), extra);
    for (const r of b) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); } }
  return rows;
}
const pack = (r) => [r.timestamp, r.orderType, r.isLong ? 1 : 0, Number(r.sizeDeltaUsd) / E30, Number(r.priceImpactUsd) / E30, r.totalImpactUsd == null ? null : Number(r.totalImpactUsd) / E30];

const M = marketMap(), c63 = JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")), counts = JSON.parse(fs.readFileSync(`${SP}/imp-counts.json`, "utf8"));
const todo = c63.filter((r) => !fs.existsSync(`${OUT}/${r.t}.json`)).sort((a, b) => counts[a.t] - counts[b.t]);
console.log(`к сбору: ${todo.length}`);

async function one(rec) {
  const t = rec.t, addr = M.get(t).addr, N = counts[t];
  let cnt, sample, big, mode, bigMode, exactSource;
  if (N <= SAMPLE_MAX) {
    sample = await crawl(addr, SAMPLE_MAX + 1); mode = "full"; big = []; bigMode = "внутри полного обхода";
    cnt = {}; for (let b = 0; b < 6; b++) { cnt[`b${b}_L`] = 0; cnt[`b${b}_S`] = 0; }
    for (const r of sample) cnt[`b${bidx(Number(r.sizeDeltaUsd) / E30)}_${r.isLong ? "L" : "S"}`]++;
    exactSource = "посчитано по полному обходу";
  } else {
    cnt = await exactCounts(addr); mode = "anchors"; exactSource = "totalCount запросом";
    const bigExact = cnt.b4_L + cnt.b4_S + cnt.b5_L + cnt.b5_S;
    const ex = `, sizeDeltaUsd_gte: "${e30(BIG_FROM)}"`;
    bigMode = bigExact <= BIG_MAX ? "full" : "anchors";
    big = bigMode === "full" ? await crawl(addr, BIG_MAX + 1, ex, 40) : await anchors(addr, BIG_MAX, ex, 777001);
    sample = await anchors(addr, SAMPLE_MAX);
  }
  const bigExact = cnt.b4_L + cnt.b4_S + cnt.b5_L + cnt.b5_S;
  fs.writeFileSync(`${OUT}/${t}.json`, JSON.stringify({ t, addr, chain: "arbitrum", totalExecuted: N, counts: cnt, exactSource,
    sampleMode: mode, sampleN: sample.length, bigMode, bigExact, bigN: big.length,
    cols: ["ts", "orderType", "isLong", "sizeUsd", "priceImpactUsd", "totalImpactUsd"], big: big.map(pack), sample: sample.map(pack) }));
  console.log(`${t.padEnd(10)} всего=${String(N).padStart(7)} выборка=${String(sample.length).padStart(6)}(${mode}) крупных=${String(big.length).padStart(5)}/${String(bigExact).padStart(5)}(${bigMode})`);
}
let i = 0;
await Promise.all(Array.from({ length: CONC }, async () => { for (;;) { const k = i++; if (k >= todo.length) return;
  try { await one(todo[k]); } catch (e) { console.log(`СБОЙ ${todo[k].t}: ${e.message}`); } } }));
console.log("ГОТОВО");
