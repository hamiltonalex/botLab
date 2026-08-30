const U="https://api.hyperliquid.xyz/info";
const A="0x7b7f72a28fe109fa703eeed7984f2a8a68fedee2";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});return {st:r.status,t:await r.text()}}
const types=["borrowLendMarkets","lendingMarkets","borrowLend","spotBorrowLend","marginMarkets","borrowMarkets","lending","borrowLendStates","portfolioMarginAssets","pmAssets","spotLending","lendingAssets","borrowLendMeta","marginTables","collateralAssets","userBorrows","userSupplies","spotState","tokenDetails","activeAssetData","spotDeployState","allPerpMetas","perpDexLimits","spotPairDetails","borrowState","supplyState","interestRates","marginAssets","pmMeta","portfolioMarginMode","accountMode","userMarginMode"];
for(const t of types){
  for(const body of [{type:t},{type:t,user:A}]){
    const r=await q(body);
    if(r.st===200){console.log("OK",t,Object.keys(body).join("+"),"->",r.t.slice(0,300).replace(/\s+/g," "));break}
  }
}
