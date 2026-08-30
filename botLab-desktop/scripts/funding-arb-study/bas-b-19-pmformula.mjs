const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)return null;return r.json()}
const addrs=["0x9321d8117e73b0c79035f0e87debcfd8dbb1d75a","0xceec48581b3145a575508719f45da07dc57fa7ce","0xf02d16a272a842f8bac1d9a9e773aba1933454c6","0x37b81ab9e3ab04b9e3738e4891621205aaa31fd5","0xf02d028ffeddc120a3ec59602a6617303ca55eb3","0x9ffdf919da72213588f7517598394cc5535bce40","0xdd9f274410c8c704bdbb599dce6c4fb34be4f50a","0xc298efc4785f2f282838924103509156c9578a9c"];
// borrow oracle price = median(spot px, perp mark, perp oracle)
const [meta,ctxs]=await q({type:"metaAndAssetCtxs"});
const [smeta,sctxs]=await q({type:"spotMetaAndAssetCtxs"});
const med=(a)=>a.slice().sort((x,y)=>x-y)[1];
const pxOf=(sym,perpSym)=>{const pair=smeta.universe.find(p=>p.tokens[0]===smeta.tokens.find(t=>t.name===sym).index && p.isCanonical===false && sctxs.find(z=>z.coin===p.name)?.midPx);
  const c=sctxs.find(z=>z.coin===pair.name); const i=meta.universe.findIndex(u=>u.name===perpSym);
  return med([+c.midPx,+ctxs[i].markPx,+ctxs[i].oraclePx]);};
const P={HYPE:pxOf("HYPE","HYPE"),UBTC:pxOf("UBTC","BTC")};
console.log("borrow oracle px:",P);
for(const a of addrs){
  const [sp,ch]=await Promise.all([q({type:"spotClearinghouseState",user:a}),q({type:"clearinghouseState",user:a})]);
  const bal=Object.fromEntries(sp.balances.map(b=>[b.coin,+b.total]));
  const usdcSpot=bal.USDC||0, hype=bal.HYPE||0, ubtc=bal.UBTC||0;
  const mm=+ch.crossMaintenanceMarginUsed, av=+ch.marginSummary.accountValue, raw=+ch.marginSummary.totalRawUsd;
  const upnl=(ch.assetPositions||[]).reduce((s,p)=>s+ +p.position.unrealizedPnl,0);
  const cv=hype*P.HYPE*0.825 + ubtc*P.UBTC*0.75;
  const borrow=usdcSpot<0?-usdcSpot:0;
  const num=20+mm+borrow;
  const r=+sp.portfolioMarginRatio;
  const denomObs=num/r;
  console.log(a.slice(0,10),"r",r.toFixed(6),"| mm",mm.toFixed(0),"borrow",borrow.toFixed(0),"usdcSpot",usdcSpot.toFixed(0),"perpAV",av.toFixed(0),"perpRawUsd",raw.toFixed(0),"upnl",upnl.toFixed(0),
   "| collLT",cv.toFixed(0),"denomObs",denomObs.toFixed(0),"denomObs-collLT",(denomObs-cv).toFixed(0),
   "| cand: +usdcSpot>0",(cv+Math.max(usdcSpot,0)).toFixed(0),"+av",(cv+Math.max(usdcSpot,0)+av).toFixed(0),"+upnl",(cv+Math.max(usdcSpot,0)+upnl).toFixed(0));
}
