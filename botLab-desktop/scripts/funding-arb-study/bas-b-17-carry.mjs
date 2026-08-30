import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)return null;return r.json()}
const pm=JSON.parse(fs.readFileSync("bas-b-pm-accounts.json","utf8"));
const px={HYPE:83.4645,UBTC:78714.5,UETH:2475.45};
for(const p of pm){
  const b=p.sp.balances;
  const usdc=+(b.find(x=>x.coin==="USDC")?.total||0);
  const hy=+(b.find(x=>x.coin==="HYPE")?.supplied||0);
  const bt=+(b.find(x=>x.coin==="UBTC")?.supplied||0);
  if(usdc>=0 && hy===0 && bt===0) continue;
  const ch=await q({type:"clearinghouseState",user:p.a});
  const pos=(ch?.assetPositions||[]).map(x=>x.position).filter(x=>Math.abs(+x.positionValue)>1000);
  const line=pos.map(x=> (+x.szi<0?"SHORT ":"LONG ")+x.coin+" $"+(+x.positionValue/1e6).toFixed(2)+"M lev"+x.leverage.value+" liq"+(x.liquidationPx??"none"));
  console.log(p.a,"| PMratio",(+p.sp.portfolioMarginRatio).toFixed(4),
    "| spotUSDC $"+(usdc/1e6).toFixed(2)+"M",
    "| suppliedHYPE $"+(hy*px.HYPE/1e6).toFixed(2)+"M",
    "suppliedUBTC $"+(bt*px.UBTC/1e6).toFixed(2)+"M",
    "| perpAV $"+((+ch?.marginSummary?.accountValue||0)/1e6).toFixed(2)+"M");
  console.log("     perps:",line.join(" ; ")||"none");
}
