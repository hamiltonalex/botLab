const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)throw new Error(r.status);return r.json();};
const [pm,pc]=await post({type:"metaAndAssetCtxs"});
const mark=Object.fromEntries(pm.universe.map((u,i)=>[u.name,+pc[i].markPx]));
const A=["0xf02d16a272a842f8bac1d9a9e773aba1933454c6","0xf02d028ffeddc120a3ec59602a6617303ca55eb3","0x37b81ab9e3ab04b9e3738e4891621205aaa31fd5","0xdd9f274410c8c704bdbb599dce6c4fb34be4f50a","0xceec48581b3145a575508719f45da07dc57fa7ce"];
for(const a of A){
 const ch=await post({type:"clearinghouseState",user:a});
 const sp=await post({type:"spotClearinghouseState",user:a});
 console.log(`\n=== ${a}  PM=${sp.portfolioMarginEnabled} PMR=${sp.portfolioMarginRatio}`);
 for(const p of ch.assetPositions){const P=p.position;
  const m=mark[P.coin];
  console.log(`  ${P.coin} szi=${P.szi} entry=${P.entryPx} mark=${m} liqPx=${P.liquidationPx} -> move to liq = ${P.liquidationPx?((+P.liquidationPx/m-1)*100).toFixed(1)+"%":"n/a"}  maintMargin=${P.marginUsed} unreal=${P.unrealizedPnl}`);
 }
 console.log("  tokenToAvailableAfterMaintenance:",JSON.stringify(sp.tokenToAvailableAfterMaintenance));
 console.log("  supplyRatio:",JSON.stringify(sp.tokenToPortfolioSupplyRatio),"borrowRatio:",JSON.stringify(sp.tokenToPortfolioBorrowRatio));
}
