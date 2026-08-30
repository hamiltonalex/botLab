// Единицы: markets/info = ГОДОВАЯ ставка в 1e30 в рамке ИЗДЕРЖЕК; Subsquid = фактор ЗА СЕКУНДУ в 1e30.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
import { gmxMarketToCanonical } from "../../src/engine/signs.js";
const S = STUDY_DATA;
const A = JSON.parse(fs.readFileSync(`${S}/truth-a-anomalies.json`, "utf8"));
const SQ = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
const mi = await (await fetch("https://arbitrum-api.gmxinfra.io/markets/info")).json();
const byAddr = new Map(mi.markets.map((m) => [String(m.marketToken).toLowerCase(), m]));
console.log("рынок  f_short живой (за сек, конвенция Subsquid)  f_short Subsquid  отношение  |  ворота netRate");
for (const t of ["ETH", "BTC", "SOL", "LINK", "XRP", "DOGE"]) {
  const addr = A.mkt[t].market;
  const m = byAddr.get(addr.toLowerCase());
  const can = gmxMarketToCanonical(m);
  const j = await (await fetch(SQ, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: `{ f: fundingRateSnapshots(limit:1, orderBy: snapshotTimestamp_DESC, where:{marketAddress_eq:"${addr}"}) { snapshotTimestamp fundingFactorPerSecondShort } b: borrowingRateSnapshots(limit:1, orderBy: snapshotTimestamp_DESC, where:{address_eq:"${addr}"}) { borrowingFactorPerSecondShort } }` }) })).json();
  const fsq = Number(j.data.f[0].fundingFactorPerSecondShort) / 1e30;
  const bsq = Number(j.data.b[0].borrowingFactorPerSecondShort) / 1e30;
  console.log(`${t.padEnd(6)} ${can.factors.f_short.toExponential(6)}  ${fsq.toExponential(6)}  ${(can.factors.f_short / fsq).toFixed(4)}  | b_short живой ${can.factors.b_short.toExponential(3)} squid ${bsq.toExponential(3)} | ворота ok=${can.gate.ok} relErr=${Math.max(can.gate.longRelErr, can.gate.shortRelErr).toExponential(1)}`);
}
