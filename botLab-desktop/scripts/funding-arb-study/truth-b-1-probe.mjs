import { gql, scan } from "./truth-b-lib.mjs";
const S = scan();
const M = S.get("FET").market;
// 1) протокольный потолок ставки
const mi = await gql(`query($m:String!){ marketInfos(where:{marketTokenAddress_eq:$m}, limit:1){ marketTokenAddress
  minFundingFactorPerSecondLong minFundingFactorPerSecondShort
  maxFundingFactorPerSecondLong maxFundingFactorPerSecondShort
  fundingFactor fundingExponentFactor fundingFactorPerSecond longsPayShorts
  longOpenInterestUsd shortOpenInterestUsd } }`, { m: M });
console.log("=== FET marketInfo ===");
const x = mi.marketInfos[0];
for (const k in x) console.log("  ", k, "=", x[k]);
const cap = Number(x.maxFundingFactorPerSecondLong) / 1e30;
console.log(`\n  maxFundingFactorPerSecondLong / 1e30 = ${cap.toExponential(4)} /сек = ${(cap*3600*8760*100).toFixed(1)}% годовых`);

// 2) пример сделок
const ta = await gql(`query($m:String!){ tradeActions(where:{marketAddress_eq:$m, eventName_eq:"OrderExecuted", fundingFeeAmount_gt:"0"}, orderBy: timestamp_DESC, limit: 5){
  timestamp isLong orderType sizeDeltaUsd positionSizeInUsd fundingFeeAmount borrowingFeeAmount collateralTokenPriceMin initialCollateralTokenAddress positionKey } }`, { m: M });
console.log("\n=== FET tradeActions (5) ===");
console.log(JSON.stringify(ta.tradeActions, null, 1));
