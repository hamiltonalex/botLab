import fs from "node:fs";
import { SP, T0, T1, URL_ARB, gql, marketMap } from "./imp-gmx-lib.mjs";
const M = marketMap();
const c63 = JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8"));
const W = (a) => `{ marketAddress_eq: "${a}", eventName_eq: "OrderExecuted", sizeDeltaUsd_gt: "0", timestamp_gte: ${T0}, timestamp_lte: ${T1} }`;
const out = {};
for (const r of c63) {
  const m = M.get(r.t);
  const d = await gql(URL_ARB, `{ tradeActionsConnection(orderBy: timestamp_ASC, where: ${W(m.addr)}) { totalCount } }`);
  out[r.t] = d.tradeActionsConnection.totalCount;
  console.log(r.t.padEnd(10), String(out[r.t]).padStart(8));
}
fs.writeFileSync(`${SP}/imp-counts.json`, JSON.stringify(out, null, 1));
const v = Object.values(out); console.log("ИТОГО сделок:", v.reduce((a, b) => a + b, 0), "нулевых рынков:", v.filter((x) => !x).length);
