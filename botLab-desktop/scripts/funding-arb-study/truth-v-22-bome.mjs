import {q,MAP} from "./truth-v-lib.mjs";
const a=MAP.get("BOME").market;
const t0=Math.floor(Date.parse("2026-02-28T16:00:00Z")/1000), t1=Math.floor(Date.parse("2026-04-19T18:00:00Z")/1000);
const d=await q(`{ tradeActions(limit:50, orderBy: timestamp_ASC, where:{marketAddress_eq:"${a}", timestamp_gte:${t0}, timestamp_lt:${t1}}){ timestamp eventName orderType isLong sizeDeltaUsd fundingFeeAmount } }`);
console.log("ВСЕ tradeActions (любой eventName) BOME в окне 1202 часов:");
for(const x of d.tradeActions) console.log(`  ${new Date(x.timestamp*1000).toISOString()} ${x.eventName} type=${x.orderType} isLong=${x.isLong} size=$${(Number(x.sizeDeltaUsd)/1e30).toFixed(2)}`);
const o=await q(`{ orders(limit:50, orderBy: updatedAtBlock_ASC, where:{marketAddress_eq:"${a}"}){ id } }`).catch(()=>null);
// OI вокруг 2026-03-10 18:00
const m=Math.floor(Date.parse("2026-03-10T14:00:00Z")/1000);
const oi=await q(`{ fundingBalanceOiSnapshots(limit:10, orderBy: snapshotTimestamp_ASC, where:{marketAddress_eq:"${a}", snapshotTimestamp_gte:${m}}){ snapshotTimestamp longOpenInterestUsd shortOpenInterestUsd } }`);
console.log("\nOI вокруг смены f_short:");
for(const x of oi.fundingBalanceOiSnapshots) console.log(`  ${new Date(x.snapshotTimestamp*1000).toISOString()} long=$${(Number(x.longOpenInterestUsd)/1e30).toFixed(2)} short=$${(Number(x.shortOpenInterestUsd)/1e30).toFixed(2)}`);
