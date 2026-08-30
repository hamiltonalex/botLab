import fs from "node:fs";
import { gql, scan, T0, T1 } from "./truth-b-lib.mjs";
const S = scan();
const TARGETS = ["FET","S","MOODENG","BERA","FLOKI","EIGEN","WLD","STX","BONK","MEME","BOME","ORDI","TIA","LDO","WIF","AIXBT","INJ","POL"];
const Q = `query($m:String!,$a:Int!,$b:Int!,$off:Int!){ tradeActions(
  where:{marketAddress_eq:$m, eventName_eq:"OrderExecuted", timestamp_gte:$a, timestamp_lte:$b},
  orderBy:[timestamp_ASC, id_ASC], limit:1000, offset:$off){
  id timestamp isLong orderType isFundingFeeSettle sizeDeltaUsd positionSizeInUsd
  fundingFeeAmount borrowingFeeAmount positionFeeAmount
  collateralTokenPriceMin initialCollateralTokenAddress positionKey account } }`;
for (const t of TARGETS) {
  const p = `truth-b-raw/${t}.json`;
  if (fs.existsSync(p)) { console.log(t, "уже есть"); continue; }
  const m = S.get(t).market; const acc = [];
  for (let off = 0; ; off += 1000) {
    const d = await gql(Q, { m, a: T0, b: T1, off });
    acc.push(...d.tradeActions);
    if (d.tradeActions.length < 1000) break;
  }
  fs.writeFileSync(p, JSON.stringify(acc));
  console.log(t, "сделок", acc.length);
}
