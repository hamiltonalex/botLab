// Сверка живого markets/info с Subsquid: то же ли это B и тот же ли pot.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const S = STUDY_DATA;
const SQ = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
const MI = "https://arbitrum-api.gmxinfra.io/markets/info";
const SEC_PER_YEAR = 3600 * 8760;
const A = JSON.parse(fs.readFileSync(`${S}/truth-a-anomalies.json`, "utf8"));
const toks = ["ETH", "BTC", "SOL", "LINK", "ARB", "DOGE", "AVAX", "XRP", "NEAR", "UNI"];

const gql = async (q) => {
  const r = await fetch(SQ, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data;
};

const t0 = Date.now();
const mi = await (await fetch(MI)).json();
const tMi = Date.now();
const byAddr = new Map(mi.markets.map((m) => [String(m.marketToken).toLowerCase(), m]));
const now = Math.floor(Date.now() / 1000);
console.log(`markets/info: ${mi.markets.length} рынков за ${tMi - t0} мс, вес ${(JSON.stringify(mi).length / 1024).toFixed(0)} КиБ`);

for (const t of toks) {
  const addr = A.mkt[t]?.market;
  if (!addr) { console.log(t, "нет адреса"); continue; }
  const m = byAddr.get(addr.toLowerCase());
  if (!m) { console.log(t, "нет в markets/info", addr); continue; }
  const d = await gql(`{ b: fundingBalanceOiSnapshots(limit:1, orderBy:snapshotTimestamp_DESC, where:{marketAddress_eq:"${addr}"}){ snapshotTimestamp longOpenInterestInTokens shortOpenInterestInTokens useOpenInterestInTokensForBalance longFundingBalanceOiUsd shortFundingBalanceOiUsd }
    f: fundingRateSnapshots(limit:1, orderBy:snapshotTimestamp_DESC, where:{marketAddress_eq:"${addr}"}){ snapshotTimestamp fundingFactorPerSecondLong fundingFactorPerSecondShort } }`);
  const b = d.b[0], f = d.f[0];
  const E30 = 1e30;
  const Bl = Number(b.longFundingBalanceOiUsd) / E30, Bs = Number(b.shortFundingBalanceOiUsd) / E30;
  const fl = Number(f.fundingFactorPerSecondLong) / E30, fsh = Number(f.fundingFactorPerSecondShort) / E30;
  const potSq = Math.abs(fl) * Bl; // $/сек
  const potSq2 = Math.abs(fsh) * Bs;
  const oiL = Number(m.openInterestLong) / E30, oiS = Number(m.openInterestShort) / E30;
  const flLive = Number(m.fundingRateLong) / E30 / SEC_PER_YEAR;  // per sec, cost frame
  const fsLive = Number(m.fundingRateShort) / E30 / SEC_PER_YEAR;
  const potLive = Math.abs(flLive) * oiL;
  const dPot = (potLive - potSq) / potSq * 100;
  const dBl = (oiL - Bl) / Bl * 100, dBs = (oiS - Bs) / Bs * 100;
  // знак: subsquid convention f_short>0 => short RECEIVES; live cost frame f>0 => сторона ПЛАТИТ
  const payerSq = fsh > 0 ? "long" : "short";
  const payerLive = Number(m.fundingRateLong) > 0 ? "long" : "short";
  console.log(`${t.padEnd(5)} age_squid=${(now - b.snapshotTimestamp)}s useTok=${String(b.useOpenInterestInTokensForBalance).padEnd(5)} ` +
    `B_long: live=$${(oiL/1e6).toFixed(3)}M squid=$${(Bl/1e6).toFixed(3)}M dB=${dBl.toFixed(2)}% | B_short dB=${dBs.toFixed(2)}% | ` +
    `pot live=$${(potLive*3600).toFixed(3)}/ч squid=$${(potSq*3600).toFixed(3)}/ч dPot=${dPot.toFixed(2)}% | внутрисквидовое тождество=${((potSq-potSq2)/potSq*100).toExponential(1)}% | плательщик live=${payerLive} squid=${payerSq} ${payerLive===payerSq?"OK":"РАСХОЖДЕНИЕ"}`);
}
