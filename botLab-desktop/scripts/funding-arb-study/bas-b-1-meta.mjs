const U="https://api.hyperliquid.xyz/info";
async function q(body){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(!r.ok)throw new Error(body.type+" "+r.status+" "+(await r.text()).slice(0,300));return r.json();}
const out={};
for (const t of ["meta","spotMeta"]) { out[t]=await q({type:t}); }
console.log("meta top keys:",Object.keys(out.meta));
console.log("meta.universe[0]:",JSON.stringify(out.meta.universe[0]));
console.log("meta.marginTables sample:",JSON.stringify(out.meta.marginTables?.slice(0,4)));
console.log("spotMeta keys:",Object.keys(out.spotMeta));
console.log("spotMeta.tokens[0..2]:",JSON.stringify(out.spotMeta.tokens.slice(0,3)));
console.log("spotMeta.universe[0..2]:",JSON.stringify(out.spotMeta.universe.slice(0,3)));
import fs from "node:fs";
fs.writeFileSync("bas-b-meta.json",JSON.stringify(out));
