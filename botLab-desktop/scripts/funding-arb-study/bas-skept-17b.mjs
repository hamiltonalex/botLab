import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});return r.json();};
const H=JSON.parse(fs.readFileSync("bas-skept-hedged.json","utf8"));
const pick=["0x89720b18","0x5a72a5f8","0x8c830d21","0x159bfedc","0x6891ed9e"];
const addrs=[...new Set(H.filter(o=>pick.some(p=>o.a.startsWith(p))).map(o=>o.a))];
for(const a of addrs){
 const [ch,sp]=await Promise.all([post({type:"clearinghouseState",user:a}),post({type:"spotClearinghouseState",user:a})]);
 console.log(`\n=== ${a} PMR=${sp.portfolioMarginRatio} perpAccountValue=${ch.marginSummary.accountValue} maintUsed=${ch.crossMaintenanceMarginUsed}`);
 for(const p of ch.assetPositions){const P=p.position;console.log(`  perp ${P.coin} szi=${P.szi} ntl=${(+P.positionValue).toFixed(0)} lev=${P.leverage.value}${P.leverage.type} liqPx=${P.liquidationPx} marginUsed=${P.marginUsed}`);}
 for(const b of sp.balances) if(Math.abs(+b.total)>0.0001&&(b.ltv||b.token===0||+b.entryNtl>1000)) console.log("  spot",JSON.stringify(b));
}
