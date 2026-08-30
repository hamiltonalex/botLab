const EP = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
async function gql(q, v) {
  const r = await fetch(EP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 900));
  return j.data;
}
for (const t of ["PositionFeesEntity", "PositionLifecycle", "FundingFeeSettleAction"]) {
  try {
    const d = await gql(`{ __type(name:"${t}"){ fields { name type { name kind ofType { name } } } } }`);
    if (!d.__type) { console.log(`${t}: НЕТ`); continue; }
    console.log(`\n=== ${t} ===`);
    console.log(d.__type.fields.map(f => f.name).join(", "));
  } catch (e) { console.log(`${t}: ERR ${e.message}`); }
}
// какие корневые запросы вообще есть
const q = await gql(`{ __schema { queryType { fields { name } } } }`);
console.log("\n=== QUERIES ===");
console.log(q.__schema.queryType.fields.map(f=>f.name).join(", "));
