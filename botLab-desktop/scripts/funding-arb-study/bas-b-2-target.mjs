import fs from "node:fs";
const m=JSON.parse(fs.readFileSync("bas-b-meta.json","utf8"));
console.log("collateralToken:",JSON.stringify(m.meta.collateralToken));
const mt=new Map(m.meta.marginTables);
for(const c of ["BTC","ETH","HYPE","SOL"]){
  const u=m.meta.universe.find(x=>x.name===c);
  console.log(c,JSON.stringify(u),"table:",JSON.stringify(mt.get(u.marginTableId)));
}
// spot pairs of interest
const tok=new Map(m.spotMeta.tokens.map(t=>[t.index,t]));
for(const p of m.spotMeta.universe){
  const [a,b]=p.tokens.map(i=>tok.get(i).name);
  if(["HYPE","UBTC","UETH","PURR"].includes(a)&&b==="USDC") console.log("SPOT",p.name,"=",a+"/"+b,"index",p.index,"canonical",p.isCanonical,"tokenIdx",JSON.stringify(p.tokens));
}
console.log("total spot pairs:",m.spotMeta.universe.length,"tokens:",m.spotMeta.tokens.length);
