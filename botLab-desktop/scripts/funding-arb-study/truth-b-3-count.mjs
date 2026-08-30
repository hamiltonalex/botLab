import { gql, scan, T0, T1 } from "./truth-b-lib.mjs";
const S = scan();
const TARGETS = ["FET","S","MOODENG","BERA","FLOKI","EIGEN","WLD","STX","BONK","MEME","BOME","ORDI","TIA","LDO","WIF","AIXBT","INJ","POL"];
for (const t of TARGETS) {
  const m = S.get(t)?.market; if (!m) { console.log(t, "нет рынка"); continue; }
  const d = await gql(`query($m:String!,$a:Int!,$b:Int!){
    all: tradeActionsConnection(where:{marketAddress_eq:$m, eventName_eq:"OrderExecuted", timestamp_gte:$a, timestamp_lte:$b}, orderBy:id_ASC, first:0){ totalCount }
    fee: tradeActionsConnection(where:{marketAddress_eq:$m, eventName_eq:"OrderExecuted", timestamp_gte:$a, timestamp_lte:$b, fundingFeeAmount_gt:"0"}, orderBy:id_ASC, first:0){ totalCount } }`,
    { m, a: T0, b: T1 });
  console.log(t.padEnd(8), "всего сделок", String(d.all.totalCount).padStart(7), " из них с фандингом>0", String(d.fee.totalCount).padStart(7));
}
