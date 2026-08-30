import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{for(let i=0;i<4;i++){try{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(r.ok)return r.json();await new Promise(s=>setTimeout(s,700));}catch(e){await new Promise(s=>setTimeout(s,700));}}return null;};
const [pm,pc]=await post({type:"metaAndAssetCtxs"});
const uni=Object.fromEntries(pm.universe.map((u,i)=>[u.name,{mark:+pc[i].markPx,maxLev:u.maxLeverage}]));
const res=await post({type:"allBorrowLendReserveStates"});
const RES=Object.fromEntries(res.map(([id,r])=>[id,r]));
const TOK={150:"HYPE",197:"UBTC"};
const found=JSON.parse(fs.readFileSync("bas-skept-pm.json","utf8"));
const out=[];
for(let i=0;i<found.length;i+=20){
 const b=found.slice(i,i+20);
 const chs=await Promise.all(b.map(x=>post({type:"clearinghouseState",user:x.a})));
 for(let k=0;k<b.length;k++){const {a,sp}=b[k],ch=chs[k];if(!ch)continue;
  const coll={},supplied={};
  for(const bal of sp.balances){const r=RES[bal.token];if(!r||+r.ltv<=0)continue;
    const s=+(bal.supplied||0), tot=+bal.total; coll[TOK[bal.token]||bal.token]={units:tot,supplied:s,usd:tot*(+r.oraclePx),ltv:+r.ltv};}
  const usdc=sp.balances.find(x=>x.token===0); const usdcTot=usdc?+usdc.total:0;
  for(const p of ch.assetPositions){const P=p.position; const szi=+P.szi; if(szi>=0)continue;
    const c=coll[P.coin==="BTC"?"UBTC":P.coin]; if(!c||c.units<=0)continue;
    const hr=c.units/Math.abs(szi); // hedge ratio spot/short
    const eq=(+ch.marginSummary.accountValue)+Object.values(coll).reduce((s,x)=>s+x.usd,0)+usdcTot;
    const N=+P.positionValue;
    out.push({a,coin:P.coin,short:Math.abs(szi),spot:c.units,hr,liq:+P.liquidationPx,mark:uni[P.coin].mark,
      up:P.liquidationPx?(+P.liquidationPx/uni[P.coin].mark-1)*100:null,N,eq,eqN:eq/N,pmr:+sp.portfolioMarginRatio,debt:usdcTot<0?-usdcTot:0});
  }
 }
}
out.sort((x,y)=>y.N-x.N);
console.log("PM accounts with a SHORT perp and matching supplied spot (the construction). n="+out.length);
console.log("addr        coin  shortNtl$M  spot/short  equity/N   debt$M   PMR    apiLiqPx   rise-to-liq");
for(const o of out.slice(0,40))
 console.log(`${o.a.slice(0,10)} ${o.coin.padEnd(5)} ${(o.N/1e6).toFixed(2).padStart(9)} ${o.hr.toFixed(3).padStart(10)} ${o.eqN.toFixed(3).padStart(9)} ${(o.debt/1e6).toFixed(2).padStart(7)} ${o.pmr.toFixed(3).padStart(6)} ${o.liq?o.liq.toFixed(2).padStart(10):"    none  "} ${o.up!==null?(o.up.toFixed(1)+"%").padStart(9):"      inf"}`);
fs.writeFileSync("bas-skept-hedged.json",JSON.stringify(out,null,1));
// group: near-hedged (0.8..1.3) and equity/N>=0.9
const nice=out.filter(o=>o.hr>0.8&&o.hr<1.5);
console.log("\nnear-hedged (spot/short in 0.8..1.5), n="+nice.length);
for(const o of nice) console.log(`  ${o.a.slice(0,10)} ${o.coin} N=$${(o.N/1e6).toFixed(2)}M hr=${o.hr.toFixed(3)} eq/N=${o.eqN.toFixed(2)} debt=$${(o.debt/1e6).toFixed(2)}M PMR=${o.pmr.toFixed(3)} rise-to-liq=${o.up===null?"inf":o.up.toFixed(1)+"%"}`);
