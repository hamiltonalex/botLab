const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)throw new Error(r.status);return r.json();};
const walk=(lv,mid,notional)=>{let need=notional,cost=0,got=0;for(const l of lv){const px=+l.px,sz=+l.sz,n=px*sz;const take=Math.min(need,n);cost+=take/px*px;got+=take/px;need-=take;if(need<=0)break;}
 if(need>0)return null; const avg=notional/got; return (avg/mid-1)*1e4;};
const PAIRS=[["HYPE","@107"],["BTC","@142"],["ETH","@151"],["SOL","@156"]];
const SZ=[1e5,5e5,1e6,2e6,5e6,1e7,2e7];
console.log("nSigFigs=null (finest). impact in bp vs mid. 'x' = book exhausted.");
console.log("pair       side  levels  topDepth$   " + SZ.map(s=>("$"+(s/1e6).toFixed(1)+"M").padStart(8)).join(""));
const store={};
for(const [perp,spot] of PAIRS) for(const [lbl,coin] of [["perp",perp],["spot",spot]]){
 const b=await post({type:"l2Book",coin});
 const bid=b.levels[0],ask=b.levels[1];
 const mid=(+bid[0].px + +ask[0].px)/2;
 const depthA=ask.reduce((s,l)=>s+ +l.px* +l.sz,0), depthB=bid.reduce((s,l)=>s+ +l.px* +l.sz,0);
 store[coin]={mid,ask,bid};
 // buy spot leg = take asks ; sell/short perp leg = take bids
 const lv = lbl==="spot"?ask:bid;
 const sgn = lbl==="spot"?1:-1;
 const cells=SZ.map(s=>{const r=walk(lv,mid,s);return r===null?"       x":(sgn*r).toFixed(1).padStart(8);});
 console.log(`${coin.padEnd(6)} ${lbl}  ${String(lv.length).padStart(5)}  ${((lbl==="spot"?depthA:depthB)/1e6).toFixed(2).padStart(8)}M  ${cells.join("")}`);
}
console.log("\nround-trip pair cost (spot buy + perp sell impact, no fees):");
for(const [perp,spot] of PAIRS){
 const s=store[spot],p=store[perp];
 const cells=SZ.map(n=>{const a=walk(s.ask,s.mid,n),b=walk(p.bid,p.mid,n);return (a===null||b===null)?"       x":(a-b).toFixed(1).padStart(8);});
 console.log(`${perp.padEnd(6)}                          ${cells.join("")}`);
}
