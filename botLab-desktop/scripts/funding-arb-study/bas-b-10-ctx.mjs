import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)return{err:r.status,t:await r.text()};return r.json()}
const [meta,ctxs]=await q({type:"metaAndAssetCtxs"});
const [smeta,sctxs]=await q({type:"spotMetaAndAssetCtxs"});
const mt=new Map(meta.marginTables);
const rows=[];
for(const c of ["HYPE","BTC","ETH","SOL"]){
  const i=meta.universe.findIndex(x=>x.name===c);const u=meta.universe[i],x=ctxs[i];
  rows.push({coin:c,maxLev:u.maxLeverage,imMax:1/u.maxLeverage,mm:1/(2*u.maxLeverage),tiers:mt.get(u.marginTableId).marginTiers,
    mark:+x.markPx,oracle:+x.oraclePx,funding:+x.funding,oi:+x.openInterest*+x.markPx,dayNtlVlm:+x.dayNtlVlm,premium:+x.premium,impactPx:x.impactPxs});
}
console.log(JSON.stringify(rows,null,1));
const stok=new Map(smeta.tokens.map(t=>[t.index,t.name]));
for(const p of smeta.universe){
  const nm=stok.get(p.tokens[0]);
  if(!["HYPE","UBTC","UETH","PURR","USOL"].includes(nm))continue;
  const c=sctxs.find(z=>z.coin===p.name);
  console.log("SPOT",nm,p.name,"mid",c?.midPx,"mark",c?.markPx,"dayNtlVlm",c?.dayNtlVlm,"circ",c?.circulatingSupply);
}
fs.writeFileSync("bas-b-ctx.json",JSON.stringify({rows}));
