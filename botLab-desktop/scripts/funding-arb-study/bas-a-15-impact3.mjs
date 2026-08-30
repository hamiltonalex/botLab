import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});return r.json();};
const cands=JSON.parse(fs.readFileSync("bas-a-cands.json","utf8"));
const SZ=[5e4,1e5,2.5e5,5e5,1e6,2e6];
const sweep=(lv,mid,usd,sign)=>{let left=usd,got=0;
  for(const l of lv){const px=+l.px,cap=px*(+l.sz);const take=Math.min(left,cap);got+=take/px;left-=take;if(left<=1e-9)break;}
  if(left>1e-9)return null; return 1e4*sign*(usd/got-mid)/mid;};
console.log("TAKER IMPACT vs mid, nSigFigs=4 book (tick floor noted). bp.");
console.log("coin    leg         tickBp   $50k  $100k  $250k  $500k    $1M    $2M   sideDepth$");
const out={};
for (const c of cands){
  const rows={};
  for (const [leg,coin,side,sign] of [["spot buy",c.pair,1,+1],["perp sell",c.perp,0,-1]]){
    const bk=await post({type:"l2Book",coin,nSigFigs:4});
    if(!bk?.levels||!bk.levels[0].length||!bk.levels[1].length){console.log(c.base,leg,"no book");continue;}
    const mid=(+bk.levels[0][0].px + +bk.levels[1][0].px)/2, lv=bk.levels[side];
    const tick = lv.length>1 ? Math.abs(+lv[1].px - +lv[0].px) : NaN;
    const dep=lv.reduce((s,l)=>s+(+l.px)*(+l.sz),0);
    const r=SZ.map(z=>sweep(lv,mid,z,sign));
    rows[leg]={mid,dep,r,tickBp:1e4*tick/mid};
    console.log(`${c.base.padEnd(7)} ${leg.padEnd(10)} ${(1e4*tick/mid).toFixed(2).padStart(7)} ${r.map(x=>(x===null?" --":x.toFixed(1)).padStart(6)).join("")} ${Math.round(dep).toLocaleString().padStart(13)}`);
    await new Promise(s=>setTimeout(s,150));
  }
  out[c.base]=rows;
}
fs.writeFileSync("bas-a-impact3.json",JSON.stringify(out,null,1));
console.log("\nENTRY COST of the pair, bp of notional = spot impact + perp impact + base taker fees (7.0 spot + 4.5 perp = 11.5)");
console.log("coin       $50k  $100k  $250k  $500k    $1M    $2M");
for (const c of cands){ const o=out[c.base]; if(!o["spot buy"]||!o["perp sell"])continue;
  console.log(`${c.base.padEnd(8)}${SZ.map((z,i)=>{const a=o["spot buy"].r[i],b=o["perp sell"].r[i];return (a===null||b===null)?"  --":(a+b+11.5).toFixed(1);}).map(x=>x.padStart(7)).join("")}`);}
