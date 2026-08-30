import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{for(let i=0;i<4;i++){try{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(r.ok)return r.json();await new Promise(s=>setTimeout(s,700));}catch(e){await new Promise(s=>setTimeout(s,700));}}return null;};
const [pm,pc]=await post({type:"metaAndAssetCtxs"});
const uni=Object.fromEntries(pm.universe.map((u,i)=>[u.name,{mark:+pc[i].markPx,mL:u.maxLeverage}]));
const lb=JSON.parse(fs.readFileSync("bas-skept-lb.json","utf8"));
const rows=(lb.leaderboardRows||lb).sort((a,b)=>+b.accountValue-+a.accountValue).slice(0,400);
const pmset=new Set(JSON.parse(fs.readFileSync("bas-skept-pm.json","utf8")).map(x=>x.a.toLowerCase()));
let ok=0,bad=0,checked=0;const ex=[];
for(let i=0;i<rows.length&&checked<40;i+=1){
 const a=rows[i].ethAddress; if(pmset.has(a.toLowerCase()))continue;
 const ch=await post({type:"clearinghouseState",user:a}); if(!ch)continue;
 const P=ch.assetPositions.filter(x=>x.position.leverage.type==="cross"&&x.position.liquidationPx);
 if(ch.assetPositions.length!==1||!P.length)continue;
 const p=P[0].position,u=uni[p.coin]; if(!u)continue;
 const l=+ch.crossMaintenanceMarginUsed/ +p.positionValue;
 const side=Math.sign(+p.szi), mav=+ch.marginSummary.accountValue - +ch.crossMaintenanceMarginUsed;
 const calc=u.mark - side*(mav/Math.abs(+p.szi))/(1-side*l);
 const err=Math.abs(calc/ +p.liquidationPx-1)*100; checked++;
 if(err<1)ok++;else{bad++;ex.push(`${a.slice(0,10)} ${p.coin} calc=${calc.toFixed(4)} api=${p.liquidationPx} err=${err.toFixed(2)}%`);}
}
console.log(`NON-PM single-position cross accounts checked: ${checked}; classic formula reproduces liquidationPx within 1%: ${ok}; mismatches: ${bad}`);
ex.slice(0,5).forEach(x=>console.log("  ",x));
