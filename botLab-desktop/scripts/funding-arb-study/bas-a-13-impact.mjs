import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});return r.json();};
const cands=JSON.parse(fs.readFileSync("bas-a-cands.json","utf8"));
const walk=(lv,mid,usd)=>{let left=usd,cost=0,got=0;
  for(const l of lv){const px=+l.px,sz=+l.sz;const cap=px*sz;const take=Math.min(left,cap);got+=take/px;left-=take;if(left<=1e-9)break;}
  if(left>1e-9) return {bp:NaN,filled:usd-left};
  const avg=usd/got; return {bp:1e4*(avg-mid)/mid, filled:usd};};
const SZ=[1e5,2.5e5,5e5,1e6,2.5e6];
console.log("IMPACT (nSigFigs=3 aggregated book, one side, taker sweep from mid, bp)");
console.log("coin    side        $100k    $250k    $500k     $1M    $2.5M   bookDepth$");
const out={};
for (const c of cands){
  for (const [tag,coin,side] of [["spot BUY",c.pair,1],["perp SELL",c.perp,0]]){
    let bk=await post({type:"l2Book",coin,nSigFigs:3});
    if(!bk?.levels) bk=await post({type:"l2Book",coin});
    const mid=(+bk.levels[0][0].px + +bk.levels[1][0].px)/2;
    const lv=bk.levels[side];
    const tot=lv.reduce((s,l)=>s+ (+l.px)*(+l.sz),0);
    const r=SZ.map(z=>walk(lv,mid,z));
    console.log(`${c.base.padEnd(7)} ${tag.padEnd(10)} ${r.map(x=>(Number.isFinite(x.bp)?x.bp.toFixed(1):"n/a").padStart(8)).join("")} ${Math.round(tot).toLocaleString().padStart(12)}`);
    out[c.base]=out[c.base]||{}; out[c.base][side?"spotBuy":"perpSell"]={mid,tot,bp:r.map(x=>x.bp)};
    await new Promise(s=>setTimeout(s,150));
  }
}
fs.writeFileSync("bas-a-impact.json",JSON.stringify(out,null,1));
console.log("\nROUND-TRIP entry impact of the pair (spot buy + perp sell), bp of notional:");
console.log("coin      $100k    $250k    $500k     $1M    $2.5M");
for (const c of cands){ const o=out[c.base]; if(!o?.spotBuy||!o?.perpSell) continue;
  console.log(`${c.base.padEnd(8)}${o.spotBuy.bp.map((v,i)=>{const s=v+o.perpSell.bp[i];return (Number.isFinite(s)?s.toFixed(1):"n/a").padStart(8);}).join("")}`);}
