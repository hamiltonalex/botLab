import { T0, T1, URL_ARB, E30, gql, marketMap } from "./imp-gmx-lib.mjs";
const M = marketMap(); const addr = M.get("SHIB").addr;
const e30 = (u) => BigInt(Math.round(u)) * 10n ** 30n;
const W = (x = "") => `{ marketAddress_eq: "${addr}", eventName_eq: "OrderExecuted", sizeDeltaUsd_gt: "0", timestamp_gte: ${T0}, timestamp_lte: ${T1}${x} }`;
const d = await gql(URL_ARB, `{
  all: tradeActionsConnection(orderBy: timestamp_ASC, where: ${W()}) { totalCount }
  lo:  tradeActionsConnection(orderBy: timestamp_ASC, where: ${W(`, sizeDeltaUsd_lt: "${e30(1000)}"`)}) { totalCount }
  hi:  tradeActionsConnection(orderBy: timestamp_ASC, where: ${W(`, sizeDeltaUsd_gte: "${e30(1000)}"`)}) { totalCount }
  big: tradeActionsConnection(orderBy: timestamp_ASC, where: ${W(`, sizeDeltaUsd_gte: "${e30(50000)}"`)}) { totalCount }
}`);
console.log("SHIB счётчики", d.all.totalCount, "= lo", d.lo.totalCount, "+ hi", d.hi.totalCount, "=", d.lo.totalCount + d.hi.totalCount, "| >=50k:", d.big.totalCount);
const s = await gql(URL_ARB, `{ tradeActions(limit: 5, orderBy: timestamp_ASC, where: ${W(`, sizeDeltaUsd_gte: "${e30(50000)}"`)}) { timestamp orderType isLong sizeDeltaUsd priceImpactUsd totalImpactUsd } }`);
for (const r of s.tradeActions) console.log(r.timestamp, "ot", r.orderType, "long", r.isLong, "$" + (Number(r.sizeDeltaUsd) / E30).toFixed(0),
  "imp", (Number(r.priceImpactUsd) / E30).toFixed(2), "bps", (1e4 * Number(r.priceImpactUsd) / Number(r.sizeDeltaUsd)).toFixed(2));
