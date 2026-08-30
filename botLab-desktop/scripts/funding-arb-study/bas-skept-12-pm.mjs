const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)throw new Error(r.status+" "+(await r.text()).slice(0,150));return r.json();};
const A=["0xf02d16a272a842f8bac1d9a9e773aba1933454c6","0xf02d028ffeddc120a3ec59602a6617303ca55eb3","0x37b81ab9e3ab04b9e3738e4891621205aaa31fd5","0xdd9f274410c8c704bdbb599dce6c4fb34be4f50a","0xceec48581b3145a575508719f45da07dc57fa7ce","0x399965e15d4e61ec3529cc98b7f7ebb93b733336","0xe2321c8324c1da7b3ba790627d0e4ee444188a23"];
for(const a of A){
 const [ch,sp]=await Promise.all([post({type:"clearinghouseState",user:a}),post({type:"spotClearinghouseState",user:a})]);
 const ms=ch.marginSummary;
 const pos=ch.assetPositions.map(p=>`${p.position.coin} szi=${p.position.szi} ntl=${(+p.position.positionValue).toFixed(0)} lev=${p.position.leverage.value}${p.position.leverage.type[0]}`).join(" | ");
 console.log(`\n=== ${a}`);
 console.log(` perp: accountValue=${ms.accountValue} ntlPos=${ms.totalNtlPos} rawUsd=${ms.totalRawUsd} maintUsed=${ch.crossMaintenanceMarginUsed} withdrawable=${ch.withdrawable}`);
 console.log(` pos: ${pos||"(none)"}`);
 console.log(` spot keys: ${Object.keys(sp).join(",")}`);
 if(sp.portfolioMarginEnabled!==undefined) console.log(` PM=${sp.portfolioMarginEnabled} ratio=${sp.portfolioMarginRatio} borrowRatios=${JSON.stringify(sp.tokenToPortfolioBorrowRatio)?.slice(0,200)}`);
 for(const b of sp.balances) if(+b.total!==0||b.borrowed||b.supplied) console.log("   bal",JSON.stringify(b));
}
