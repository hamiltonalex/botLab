// Во что обходится ЕДИНСТВЕННЫЙ нежививой вход - оценка устойчивости ставки по истории.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const S = STUDY_DATA;
const A = JSON.parse(fs.readFileSync(`${S}/truth-a-anomalies.json`, "utf8"));
const SQ = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
const HL = "https://api.hyperliquid.xyz/info";
const now = Math.floor(Date.now() / 1000), from = now - 30 * 86400;

let t0 = Date.now(), nHl = 0, rowsHl = 0;
let cur = from * 1000;
for (;;) {
  const b = await (await fetch(HL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "fundingHistory", coin: "ETH", startTime: cur }) })).json();
  nHl++; rowsHl += b.length;
  if (b.length < 500) break;
  cur = Number(b[b.length - 1].time) + 1;
  if (cur > now * 1000) break;
}
console.log(`HL fundingHistory 30 суток по ОДНОЙ монете: ${nHl} запросов, ${rowsHl} строк, ${Date.now() - t0} мс -> на 25 монет ~${nHl * 25} запросов`);

t0 = Date.now();
const addr = A.mkt.ETH.market;
let nSq = 0, rowsSq = 0, cursor = from - 1;
for (;;) {
  const q = `{ fundingRateSnapshots(limit:1000, orderBy: snapshotTimestamp_ASC, where:{ marketAddress_eq:"${addr}", snapshotTimestamp_gt:${cursor}, snapshotTimestamp_lte:${now} }) { snapshotTimestamp fundingFactorPerSecondLong fundingFactorPerSecondShort } }`;
  const j = await (await fetch(SQ, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) })).json();
  const b = j.data.fundingRateSnapshots; nSq++; rowsSq += b.length;
  if (!b.length || b.length < 1000) break;
  cursor = b[b.length - 1].snapshotTimestamp;
}
console.log(`Subsquid fundingRateSnapshots 30 суток по ОДНОМУ рынку: ${nSq} запросов, ${rowsSq} строк, ${Date.now() - t0} мс`);
console.log(`нужны ещё balance-снимки (база B) и borrow -> x3 сущности; на 25 рынков ~${nSq * 3 * 25} запросов`);
