const URL="https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
async function q(body){const r=await fetch(URL,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:body})});const j=await r.json();if(j.errors)console.error(JSON.stringify(j.errors).slice(0,500));return j.data;}
const types=["OnChainSetting","MarketInfo","FundingBalanceOiSnapshot","FundingRateSnapshot","TradeAction","Market"];
for(const t of types){
  const d=await q(`{ __type(name:"${t}"){ name fields{ name type{ name kind ofType{name kind} } } } }`);
  if(!d||!d.__type){console.log(t,"НЕТ");continue;}
  console.log("=== "+t);
  console.log(d.__type.fields.map(f=>f.name+":"+(f.type.name||f.type.ofType?.name||f.type.kind)).join("  "));
  console.log();
}
