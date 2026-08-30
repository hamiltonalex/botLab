const EP = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
async function gql(q, v) {
  const r = await fetch(EP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }) });
  const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0,900)); return j.data;
}
for (const t of ["Position","PositionChange","FundingBalanceOiSnapshot","MarketInfo","ClaimableFundingFeeInfo","CollectedFeesInfo"]) {
  const d = await gql(`{ __type(name:"${t}"){ fields { name } } }`);
  console.log(`\n=== ${t} ===\n` + (d.__type ? d.__type.fields.map(f=>f.name).join(", ") : "НЕТ"));
}
