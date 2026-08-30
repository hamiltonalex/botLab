import {q,MAP,all} from "./truth-v-lib.mjs";
const a=MAP.get("BOME").market;
const m=Math.floor(Date.parse("2026-03-10T16:00:00Z")/1000);
const oi=await q(`{ fundingBalanceOiSnapshots(limit:4, orderBy: snapshotTimestamp_ASC, where:{marketAddress_eq:"${a}", snapshotTimestamp_gte:${m}}){ snapshotTimestamp longOpenInterestUsd shortOpenInterestUsd longOpenInterestInTokens shortOpenInterestInTokens useOpenInterestInTokensForBalance longFundingBalanceOiUsd shortFundingBalanceOiUsd } }`);
const rows=all.get("BOME");
for(const x of oi.fundingBalanceOiSnapshots){
  const r=rows.find(z=>z.tsHour===x.snapshotTimestamp);
  const LT=Number(x.longOpenInterestInTokens), ST=Number(x.shortOpenInterestInTokens);
  const LB=Number(x.longFundingBalanceOiUsd)/1e30, SB=Number(x.shortFundingBalanceOiUsd)/1e30;
  console.log(`${new Date(x.snapshotTimestamp*1000).toISOString()} inTokensFlag=${x.useOpenInterestInTokensForBalance}`);
  console.log(`  OI USD  long=$${(Number(x.longOpenInterestUsd)/1e30).toFixed(2)} short=$${(Number(x.shortOpenInterestUsd)/1e30).toFixed(2)}   OI токены long=${LT} short=${ST}  L/S=${(LT/ST).toFixed(4)}`);
  console.log(`  fundingBalanceOi long=$${LB.toFixed(2)} short=$${SB.toFixed(2)}  L/S=${(LB/SB).toFixed(4)}`);
  console.log(`  f_long=${r.f_long.toExponential(5)} f_short=${r.f_short.toExponential(5)}  |f_S|/|f_L|=${(Math.abs(r.f_short)/Math.abs(r.f_long)).toFixed(4)}`);
}
