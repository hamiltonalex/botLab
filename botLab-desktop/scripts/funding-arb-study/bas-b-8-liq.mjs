import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)return{err:r.status};return r.json()}
const lb=JSON.parse(fs.readFileSync("bas-b-lb.json","utf8"));
let found=[],scanned=0;
for(const row of lb){
  const f=await q({type:"userFills",user:row.ethAddress});
  scanned++;
  if(!Array.isArray(f))continue;
  const liq=f.filter(x=>x.liquidation);
  if(liq.length){found.push({a:row.ethAddress,n:liq.length,s:liq[0]});if(found.length>=3)break;}
}
console.log("scanned",scanned,"addresses with liquidation fills:",found.length);
for(const x of found) console.log(x.a,x.n,JSON.stringify(x.s));
