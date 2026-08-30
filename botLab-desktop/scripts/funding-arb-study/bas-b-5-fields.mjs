import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});const t=await r.text();if(!r.ok)return{err:r.status,t:t.slice(0,300)};return JSON.parse(t)}
const A="0x7b7f72a28fe109fa703eeed7984f2a8a68fedee2";
const ch=await q({type:"clearinghouseState",user:A});
const sp=await q({type:"spotClearinghouseState",user:A});
console.log("=== clearinghouseState top keys:",Object.keys(ch));
console.log("marginSummary:",JSON.stringify(ch.marginSummary));
console.log("crossMarginSummary:",JSON.stringify(ch.crossMarginSummary));
console.log("crossMaintenanceMarginUsed:",ch.crossMaintenanceMarginUsed,"withdrawable:",ch.withdrawable);
console.log("--- positions:");
for(const p of ch.assetPositions) console.log(" ",p.type,JSON.stringify(p.position));
console.log("=== spotClearinghouseState keys:",Object.keys(sp));
console.log(JSON.stringify(sp.balances.filter(b=>+b.total>0),null,1));
fs.writeFileSync("bas-b-state-7b7f.json",JSON.stringify({ch,sp},null,1));
