const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)throw new Error(r.status+" "+await r.text());return r.json();};
const [spot,perp]=await Promise.all([post({type:"spotMetaAndAssetCtxs"}),post({type:"metaAndAssetCtxs"})]);
const [sm,sc]=spot,[pm,pc]=perp;
console.log("spot universe len",sm.universe.length,"ctx len",sc.length,"tokens",sm.tokens.length);
console.log("perp universe len",pm.universe.length,"ctx len",pc.length);
// alignment probe
for(const i of [0,1,105,106,107,140,142,150,151,156,272]){
  const u=sm.universe[i],c=sc[i];
  if(!u)continue;
  console.log(`idx ${i}: universe.name=${u.name} index=${u.index} tokens=[${u.tokens}] | ctx.coin=${c?.coin} midPx=${c?.midPx} dayNtlVlm=${c?.dayNtlVlm}`);
}
// does ctx have coin at all?
console.log("ctx[0] keys:",Object.keys(sc[0]));
console.log("sample ctx[105]:",JSON.stringify(sc[105]));
console.log("universe[105]:",JSON.stringify(sm.universe[105]));
// find HYPE token index
const tokIdx=new Map(sm.tokens.map(t=>[t.index,t.name]));
const find=(nm)=>sm.universe.filter(u=>u.tokens.some(t=>tokIdx.get(t)===nm));
for(const nm of ["HYPE","UBTC","UETH","USOL","UZEC","PURR"]) console.log(nm,"->",JSON.stringify(find(nm).map(u=>({name:u.name,index:u.index,toks:u.tokens.map(t=>tokIdx.get(t))}))));
import("node:fs").then(fs=>fs.writeFileSync("bas-skept-spot.json",JSON.stringify(spot)));
import("node:fs").then(fs=>fs.writeFileSync("bas-skept-perp.json",JSON.stringify(perp)));
