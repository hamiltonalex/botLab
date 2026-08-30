import { URL_ARB, gql } from "./imp-gmx-lib.mjs";
const d = await gql(URL_ARB, `{ __type(name:"TradeAction"){ fields { name type { name kind ofType{name} } } } }`);
console.log(d.__type.fields.map(f=>f.name).join("\n"));
