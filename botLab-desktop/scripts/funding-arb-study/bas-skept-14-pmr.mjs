const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)throw new Error(r.status);return r.json();};
const [pm,pc]=await post({type:"metaAndAssetCtxs"});
const uni=Object.fromEntries(pm.universe.map((u,i)=>[u.name,{...u,mark:+pc[i].markPx,i}]));
const res=await post({type:"allBorrowLendReserveStates"});
const RES=Object.fromEntries(res.map(([id,r])=>[id,r]));
const A=["0xf02d16a272a842f8bac1d9a9e773aba1933454c6","0xf02d028ffeddc120a3ec59602a6617303ca55eb3","0x37b81ab9e3ab04b9e3738e4891621205aaa31fd5","0xdd9f274410c8c704bdbb599dce6c4fb34be4f50a","0xceec48581b3145a575508719f45da07dc57fa7ce"];
console.log("acct        PMRcalc   PMRapi    err%   | classicLiq  apiLiq   impliedExtra$   PMdenom-PMnum  ratio");
for(const a of A){
 const ch=await post({type:"clearinghouseState",user:a}), sp=await post({type:"spotClearinghouseState",user:a});
 let num=20+ +ch.crossMaintenanceMarginUsed, den=0;
 for(const b of sp.balances){const r=RES[b.token]; if(!r)continue; const px=+r.oraclePx, ltv=+r.ltv, tot=+b.total;
   if(b.token===0){ if(tot<0) num+= -tot; else den+= tot; }
   else if(ltv>0 && tot>0) den += tot*px*(0.5+0.5*ltv);
 }
 const pmr=num/den, api=+sp.portfolioMarginRatio;
 // classic liq for the largest perp position
 const P=ch.assetPositions.map(x=>x.position).sort((x,y)=>+y.positionValue-+x.positionValue)[0];
 const u=uni[P.coin], mL=u.maxLeverage, l=1/(2*mL), mark=u.mark, szi=+P.szi, side=Math.sign(szi);
 const mav=+ch.marginSummary.accountValue - +ch.crossMaintenanceMarginUsed;
 const classic = mark - side*(mav/Math.abs(szi))/(1-side*l);
 const apiL=+P.liquidationPx;
 // implied extra margin so that classic formula reproduces apiL
 const extra = (Math.abs(apiL-mark)*(1-side*l))*Math.abs(szi) - mav;
 console.log(`${a.slice(0,10)} ${pmr.toFixed(6)} ${api.toFixed(6)} ${((pmr/api-1)*100).toFixed(2).padStart(6)} | ${classic.toFixed(2).padStart(10)} ${apiL.toFixed(2).padStart(9)} ${(extra/1e6).toFixed(3).padStart(10)}M ${((den-num)/1e6).toFixed(3).padStart(10)}M ${(extra/(den-num)).toFixed(4)}`);
}
