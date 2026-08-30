import { gql } from "./truth-b-lib.mjs";
const d = await gql(`{ __schema { queryType { fields { name } } } }`);
const names = d.__schema.queryType.fields.map(f=>f.name);
console.log("ВСЕГО типов запросов:", names.length);
console.log(names.filter(n=>/claim|fund|fee|position|collect/i.test(n)).join("\n"));
