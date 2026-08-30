import {q,MAP} from "./truth-v-lib.mjs";
const a=MAP.get("BOME").market;
const d=await q(`{ tradeActionsConnection(orderBy: timestamp_ASC, first:0, where:{marketAddress_eq:"${a}", eventName_eq:"OrderExecuted", timestamp_gte:1772294400, timestamp_lte:1776614400}) { totalCount } }`);
console.log(JSON.stringify(d));
const o=await q(`{ fundingBalanceOiSnapshots(limit:3, where:{marketAddress_eq:"${a}", snapshotTimestamp_gte:1772294400}, orderBy: snapshotTimestamp_ASC){ snapshotTimestamp longOpenInterestUsd shortOpenInterestUsd } }`);
console.log(JSON.stringify(o));
const s=await q(`{ onChainSettings(limit:20){ id type key value } }`);
console.log(JSON.stringify(s).slice(0,1500));
