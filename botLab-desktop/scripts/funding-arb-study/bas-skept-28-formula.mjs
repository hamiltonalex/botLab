import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{for(let i=0;i<4;i++){try{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(r.ok)return r.json();await new Promise(s=>setTimeout(s,700));}catch(e){await new Promise(s=>setTimeout(s,700));}}return null;};
const [pm,pc]=await post({type:"metaAndAssetCtxs"});
const uni=Object.fromEntries(pm.universe.map((u,i)=>[u.name,{mark:+pc[i].markPx}]));
const A=["0xf605cd3adabbc3110bc3efb85ebe7be57590a527","0x8def9f50456c6c4e37fa5d3d57f108ed23992dae","0x0b8aa35c28b7c6ab18f11dc168f437a8a69fd4f8",
 "0x89720b1831fd8457ea9026f5ffb476ed6d35e6bd","0x5a72a5f89b44473a33136a7c3253c519c474eec4","0x8c830d21e41ad688dbf1727ae4425573849daf41","0x6891ed9ee6a9d0649ffac2bcee814e6899a0e075","0x159bfedc86e8b3676183293eee58c723bb717cd4","0x37b81ab9e3ab04b9e3738e4891621205aaa31fd5","0xf02d028ffeddc120a3ec59602a6617303ca55eb3","0xceec48581b3145a575508719f45da07dc57fa7ce"];
console.log("model: liqPx_short = (AV + S + q*mark) / (q*(1+MMrate)),  S = extra injectable USDC");
console.log("addr        PM   coin  q          MMrate  freeSpotUSDC   S_implied     apiLiq      modelLiq(S=free) err%");
for(const a of A){
 const [ch,sp]=await Promise.all([post({type:"clearinghouseState",user:a}),post({type:"spotClearinghouseState",user:a})]);
 const usdc=sp.balances.find(x=>x.token===0);
 const free=usdc?(+usdc.total)-(+usdc.hold>0?+usdc.hold:0):0;
 const AV=+ch.marginSummary.accountValue;
 for(const p of ch.assetPositions){const P=p.position;const q=+P.szi;if(q>=0||!P.liquidationPx)continue;
  const mark=uni[P.coin].mark, l=(+ch.crossMaintenanceMarginUsed)/(+ch.marginSummary.totalNtlPos), Q=Math.abs(q);
  const S=(+P.liquidationPx)*Q*(1+l) - AV - Q*mark;
  const model=(AV+free+Q*mark)/(Q*(1+l));
  console.log(`${a.slice(0,10)} ${(sp.portfolioMarginEnabled?"PM ":"cls").padEnd(4)} ${P.coin.padEnd(5)} ${Q.toFixed(2).padStart(10)} ${(l*100).toFixed(3).padStart(6)}% ${(free/1e6).toFixed(3).padStart(11)}M ${(S/1e6).toFixed(3).padStart(11)}M ${(+P.liquidationPx).toFixed(2).padStart(10)} ${model.toFixed(2).padStart(14)} ${((model/(+P.liquidationPx)-1)*100).toFixed(2).padStart(7)}`);
 }
}
