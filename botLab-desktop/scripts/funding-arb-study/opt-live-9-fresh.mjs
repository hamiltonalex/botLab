// Решающая сверка: дождаться СВЕЖЕГО часового снимка Subsquid (возраст < 5 мин) и сверить
// живой pot/B из markets/info с балансами фандинга из индексатора.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const S = STUDY_DATA;
const SQ = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
const MI = "https://arbitrum-api.gmxinfra.io/markets/info";
const E30 = 1e30, SEC_PER_YEAR = 3600 * 8760;
const A = JSON.parse(fs.readFileSync(`${S}/truth-a-anomalies.json`, "utf8"));
const toks = ["ETH", "BTC", "SOL", "LINK", "ARB", "DOGE", "AVAX", "XRP", "NEAR", "UNI", "AAVE", "SUI", "LTC", "PEPE", "WLD", "ENA", "TRX", "ADA", "OP", "GMX"];
const gql = async (q) => {
  const r = await fetch(SQ, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) });
  const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200)); return j.data;
};
const ethAddr = A.mkt.ETH.market;
// ждём свежий снимок
for (;;) {
  const d = await gql(`{ b: fundingBalanceOiSnapshots(limit:1, orderBy:snapshotTimestamp_DESC, where:{marketAddress_eq:"${ethAddr}"}){ snapshotTimestamp } }`);
  const age = Math.floor(Date.now() / 1000) - d.b[0].snapshotTimestamp;
  if (age < 300) { console.log(`свежий снимок получен, возраст ${age} с (${new Date().toISOString()})`); break; }
  console.log(`возраст последнего снимка ${age} с, ждём 60 с...`);
  await new Promise((r) => setTimeout(r, 20000));
}
const mi = await (await fetch(MI)).json();
const byAddr = new Map(mi.markets.map((m) => [String(m.marketToken).toLowerCase(), m]));
const now = Math.floor(Date.now() / 1000);
const dPots = [], dBs = [];
let payerOk = 0, tot = 0;
for (const t of toks) {
  const addr = A.mkt[t]?.market; if (!addr) continue;
  const m = byAddr.get(addr.toLowerCase()); if (!m) continue;
  const d = await gql(`{ b: fundingBalanceOiSnapshots(limit:1, orderBy:snapshotTimestamp_DESC, where:{marketAddress_eq:"${addr}"}){ snapshotTimestamp longFundingBalanceOiUsd shortFundingBalanceOiUsd useOpenInterestInTokensForBalance }
    f: fundingRateSnapshots(limit:1, orderBy:snapshotTimestamp_DESC, where:{marketAddress_eq:"${addr}"}){ snapshotTimestamp fundingFactorPerSecondLong fundingFactorPerSecondShort } }`);
  const b = d.b[0], f = d.f[0]; if (!b || !f) continue;
  const Bl = Number(b.longFundingBalanceOiUsd) / E30, Bs = Number(b.shortFundingBalanceOiUsd) / E30;
  const fl = Number(f.fundingFactorPerSecondLong) / E30, fsh = Number(f.fundingFactorPerSecondShort) / E30;
  const potSq = Math.abs(fl) * Bl;
  const oiL = Number(m.openInterestLong) / E30, oiS = Number(m.openInterestShort) / E30;
  const flLive = Number(m.fundingRateLong) / E30 / SEC_PER_YEAR;
  const potLive = Math.abs(flLive) * oiL;
  if (!(potSq > 0) || !(Bl > 0) || !(Bs > 0)) { console.log(`${t.padEnd(6)} пропуск (нулевая база)`); continue; }
  const dPot = (potLive - potSq) / potSq * 100;
  const dBl = (oiL - Bl) / Bl * 100, dBsh = (oiS - Bs) / Bs * 100;
  const payerSq = fsh > 0 ? "long" : "short";
  const payerLive = Number(m.fundingRateLong) > 0 ? "long" : "short";
  tot++; if (payerSq === payerLive) payerOk++;
  dPots.push(Math.abs(dPot)); dBs.push(Math.abs(dBl), Math.abs(dBsh));
  console.log(`${t.padEnd(6)} возраст=${now - b.snapshotTimestamp}с B=$${(Bl/1e6).toFixed(3)}M/${(Bs/1e6).toFixed(3)}M dB=${dBl.toFixed(2)}%/${dBsh.toFixed(2)}% pot live=$${(potLive*3600).toFixed(3)}/ч squid=$${(potSq*3600).toFixed(3)}/ч dPot=${dPot.toFixed(2)}% плательщик ${payerLive}/${payerSq}${payerLive===payerSq?"":" РАСХОЖДЕНИЕ"}`);
}
const med = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
console.log(`\nрынков сверено: ${tot}; медиана |dPot| = ${med(dPots).toFixed(2)}%, макс = ${Math.max(...dPots).toFixed(2)}%`);
console.log(`медиана |dB| = ${med(dBs).toFixed(2)}%, макс = ${Math.max(...dBs).toFixed(2)}%`);
console.log(`плательщик совпал: ${payerOk}/${tot}`);
