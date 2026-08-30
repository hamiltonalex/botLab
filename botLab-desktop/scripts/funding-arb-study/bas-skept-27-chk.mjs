import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});return r.ok?r.json():null;};
const lb=JSON.parse(fs.readFileSync("bas-skept-lb.json","utf8"));
const rows=(lb.leaderboardRows||lb).sort((a,b)=>+b.accountValue-+a.accountValue).slice(0,400);
for(const pre of ["0x8def9f50","0x0b8aa35c","0xa9b95f2a","0xf605cd3a"]){
 const a=rows.find(r=>r.ethAddress.startsWith(pre))?.ethAddress; if(!a){console.log(pre,"not found");continue;}
 const [ch,sp]=await Promise.all([post({type:"clearinghouseState",user:a}),post({type:"spotClearinghouseState",user:a})]);
 console.log(`\n${a} PM=${sp.portfolioMarginEnabled} PMR=${sp.portfolioMarginRatio??"-"} AV=${ch.marginSummary.accountValue} maint=${ch.crossMaintenanceMarginUsed}`);
 for(const p of ch.assetPositions)console.log("  ",JSON.stringify(p.position).slice(0,320));
 for(const b of sp.balances) if(Math.abs(+b.total)>0.01&&(b.ltv||b.token===0)) console.log("   spot",JSON.stringify(b));
}
