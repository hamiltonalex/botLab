import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)return null;return r.json()}
const [meta,ctxs]=await q({type:"metaAndAssetCtxs"});
const [smeta,sctxs]=await q({type:"spotMetaAndAssetCtxs"});
const maxLev=new Map(meta.universe.map((u,i)=>[u.name,u.maxLeverage]));
const tokPx=new Map();
for(const p of smeta.universe){const c=sctxs.find(z=>z.coin===p.name);const t=smeta.tokens.find(t=>t.index===p.tokens[0]);
  if(c&&c.midPx&&t&&!tokPx.has(t.index))tokPx.set(t.index,+c.midPx);}
const addrs=["0xf02d16a272a842f8bac1d9a9e773aba1933454c6","0x37b81ab9e3ab04b9e3738e4891621205aaa31fd5","0xf02d028ffeddc120a3ec59602a6617303ca55eb3","0x9ffdf919da72213588f7517598394cc5535bce40","0xdd9f274410c8c704bdbb599dce6c4fb34be4f50a","0xceec48581b3145a575508719f45da07dc57fa7ce","0xc298efc4785f2f282838924103509156c9578a9c","0x9321d8117e73b0c79035f0e87debcfd8dbb1d75a"];
for(const a of addrs){
  const [sp,ch]=await Promise.all([q({type:"spotClearinghouseState",user:a}),q({type:"clearinghouseState",user:a})]);
  let borrow=0,collLtv=0,collVal=0;
  for(const b of sp.balances){const v=+b.total; const px=tokPx.get(b.token)??(b.coin==="USDC"?1:0);
    if(v<0) borrow+=-v*px; else if(b.ltv&&+b.ltv>0) {collLtv+=v*px*+b.ltv; collVal+=v*px;}
    else if(b.coin==="USDC"&&v>0) {collLtv+=v; collVal+=v;}}
  const mm=+ch.crossMaintenanceMarginUsed, av=+ch.marginSummary.accountValue;
  const r=+sp.portfolioMarginRatio;
  console.log(a.slice(0,10),"ratio",r.toFixed(6),
   "| borrow",(borrow/1e6).toFixed(3),"collLtv",(collLtv/1e6).toFixed(3),"collVal",(collVal/1e6).toFixed(3),
   "| perpAV",(av/1e6).toFixed(3),"perpMM",(mm/1e6).toFixed(3),
   "|| b/collLtv",(borrow/collLtv).toFixed(4),
   "(b+mm)/collLtv",((borrow+mm)/collLtv).toFixed(4),
   "(b+mm)/(collLtv+av)",((borrow+mm)/(collLtv+av)).toFixed(4),
   "(b+mm)/(collLtv+av-mm)",((borrow+mm)/(collLtv+av-mm)).toFixed(4));
}
