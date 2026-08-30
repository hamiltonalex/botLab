import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});return r.json();};
const cands=JSON.parse(fs.readFileSync("bas-a-cands.json","utf8"));
const SZ=[5e4,1e5,2.5e5,5e5,1e6];
const sweep=(lv,mid,usd,sign)=>{ // sign +1 buy (asks), -1 sell (bids); cost>0 always
  let left=usd,got=0;
  for(const l of lv){const px=+l.px,cap=px*(+l.sz);const take=Math.min(left,cap);got+=take/px;left-=take;if(left<=1e-9)break;}
  if(left>1e-9) return null;
  const avg=usd/got; return 1e4*sign*(avg-mid)/mid; };
console.log("TAKER IMPACT vs mid, finest book (20 levels/side). null = 20 visible levels cannot fill.");
console.log("coin    leg        $50k   $100k   $250k   $500k     $1M   | 20-level depth $   | full-book(nSigFigs3) $");
const out={};
for (const c of cands){
  const rows={};
  for (const [leg,coin,side,sign] of [["spot buy",c.pair,1,+1],["perp sell",c.perp,0,-1]]){
    const bk=await post({type:"l2Book",coin});
    const mid=(+bk.levels[0][0].px + +bk.levels[1][0].px)/2, lv=bk.levels[side];
    const vis=lv.reduce((s,l)=>s+(+l.px)*(+l.sz),0);
    const agg=await post({type:"l2Book",coin,nSigFigs:3});
    const tot=agg?.levels?agg.levels[side].reduce((s,l)=>s+(+l.px)*(+l.sz),0):NaN;
    const r=SZ.map(z=>sweep(lv,mid,z,sign));
    rows[leg]={mid,vis,tot,r};
    console.log(`${c.base.padEnd(7)} ${leg.padEnd(10)} ${r.map(x=>(x===null?"  --":x.toFixed(1)).padStart(7)).join("")}   ${Math.round(vis).toLocaleString().padStart(15)}   ${Math.round(tot).toLocaleString().padStart(20)}`);
    await new Promise(s=>setTimeout(s,150));
  }
  out[c.base]=rows;
}
fs.writeFileSync("bas-a-impact2.json",JSON.stringify(out,null,1));
console.log("\nENTRY COST of the pair = spot-buy impact + perp-sell impact + fees(base taker 7bp spot + 4.5bp perp), bp of notional");
console.log("coin       $50k   $100k   $250k   $500k     $1M");
for (const c of cands){ const o=out[c.base]; if(!o["spot buy"]) continue;
  const line=SZ.map((z,i)=>{const a=o["spot buy"].r[i],b=o["perp sell"].r[i]; return (a===null||b===null)?"  --":(a+b+11.5).toFixed(1);});
  console.log(`${c.base.padEnd(8)}${line.map(x=>x.padStart(8)).join("")}`); }
