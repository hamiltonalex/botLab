import fs from "node:fs";
const pm=JSON.parse(fs.readFileSync("bas-b-pm-accounts.json","utf8"));
const ltv=new Map(), sup=new Map(), bor=new Map();
for(const p of pm) for(const b of p.sp.balances){
  if(b.ltv!==undefined) ltv.set(b.coin+"("+b.token+")", b.ltv);
  if(b.supplied!==undefined) sup.set(b.coin,(sup.get(b.coin)||0)+ +b.supplied);
  if(b.borrowed!==undefined) bor.set(b.coin,(bor.get(b.coin)||0)+ +b.borrowed);
  for(const k of Object.keys(b)) if(!["coin","token","total","hold","entryNtl"].includes(k)) globalThis.xk=(globalThis.xk||new Set()).add(k);
}
console.log("tokens carrying ltv field:",JSON.stringify([...ltv]));
console.log("extra balance keys seen:",[...(globalThis.xk||[])]);
console.log("supplied sums:",JSON.stringify([...sup]));
console.log("borrowed sums:",JSON.stringify([...bor]));
// accounts with real borrows
for(const p of pm){
  const negs=p.sp.balances.filter(b=>+b.total<0 || (b.borrowed&&+b.borrowed>0));
  const supd=p.sp.balances.filter(b=>b.supplied&&+b.supplied>0);
  if(negs.length||+p.sp.portfolioMarginRatio>0.3) console.log(p.a,"ratio",p.sp.portfolioMarginRatio,"negs",JSON.stringify(negs.map(b=>b.coin+":"+b.total)),"supplied",JSON.stringify(supd.map(b=>b.coin+":"+b.supplied)));
}
