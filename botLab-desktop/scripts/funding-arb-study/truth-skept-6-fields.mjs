import { gql } from "./truth-b-lib.mjs";
for (const t of ["ClaimableFundingFeeInfo","ClaimAction","ClaimableAmount","PositionFeesEntity","FundingBalanceOiSnapshot","MarketInfo"]) {
  const d = await gql(`{ __type(name:"${t}"){ fields { name type { name kind ofType{name} } } } }`);
  if(!d.__type){console.log(t,"НЕТ"); continue;}
  console.log("\n=== "+t+" ===");
  console.log(d.__type.fields.map(f=>f.name+":"+(f.type.name||f.type.ofType?.name||f.type.kind)).join("  "));
}
