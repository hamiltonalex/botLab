const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});const t=await r.text();return {ok:r.ok,st:r.status,t};}
const A="0x7b7f72a28fe109fa703eeed7984f2a8a68fedee2";
const types=["portfolioMargin","portfolioMarginState","userPortfolioMargin","portfolioMarginMeta","borrowMeta","lendingMeta","marginMeta","perpsAtOpenInterestCap","spotPairDeployAuctionStatus","userRole","preTransferCheck","webData2","portfolioMarginSummary","borrowLendState","lendingState","userLending","assetLtvs","ltvs"];
for(const t of types){
  const r=await q({type:t,user:A});
  console.log(t.padEnd(28), r.st, r.t.slice(0,220).replace(/\s+/g," "));
}
