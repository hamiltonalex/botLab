import fs from "node:fs";
import { gql, scan } from "./truth-b-lib.mjs";
const S = scan();
// калибровочные рынки: там ставка заведомо нормальная
const A = Number(process.argv[3]), B = Number(process.argv[4]);
const tok = process.argv[2];
const Q = `query($m:String!,$a:Int!,$b:Int!,$off:Int!){ tradeActions(
  where:{marketAddress_eq:$m, eventName_eq:"OrderExecuted", timestamp_gte:$a, timestamp_lte:$b},
  orderBy:[timestamp_ASC, id_ASC], limit:1000, offset:$off){
  id timestamp isLong orderType isFundingFeeSettle sizeDeltaUsd positionSizeInUsd
  fundingFeeAmount borrowingFeeAmount positionFeeAmount
  collateralTokenPriceMin initialCollateralTokenAddress positionKey account } }`;
const m = S.get(tok).market;
let acc = [], a = A;
while (true) {
  let page = [];
  for (let off = 0; off < 10000; off += 1000) {
    const d = await gql(Q, { m, a, b: B, off });
    page.push(...d.tradeActions);
    if (d.tradeActions.length < 1000) { off = 1e9; break; }
  }
  if (!page.length) break;
  acc.push(...page);
  const last = page[page.length - 1].timestamp;
  if (page.length < 10000 || last >= B) break;
  a = last; // курсор с перекрытием, дубли уберём
  process.stderr.write(`${tok} ${acc.length} ${new Date(last*1000).toISOString()}\n`);
}
const seen = new Set(); const out = [];
for (const r of acc) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
out.sort((x,y)=>x.timestamp-y.timestamp);
fs.writeFileSync(`truth-skept-raw/${tok}_${A}_${B}.json`, JSON.stringify(out));
console.log(tok, "сделок", out.length, "окно", new Date(A*1000).toISOString(), new Date(B*1000).toISOString());
