import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)throw new Error(r.status+(await r.text()).slice(0,120));return r.json();};
const [sm,sc]=JSON.parse(fs.readFileSync("bas-skept-spot.json","utf8"));
const [pm,pc]=JSON.parse(fs.readFileSync("bas-skept-perp.json","utf8"));
const sctx=Object.fromEntries(sc.map(c=>[c.coin,c]));
const pctx=Object.fromEntries(pm.universe.map((u,i)=>[u.name,pc[i]]));
const tok=Object.fromEntries(sm.tokens.map(t=>[t.index,t.name]));
const rows=sm.universe.map(u=>({name:u.name,base:tok[u.tokens[0]],quote:tok[u.tokens[1]],c:sctx[u.name]}))
 .filter(r=>r.c).map(r=>({...r,vol:+r.c.dayNtlVlm}));
rows.sort((a,b)=>b.vol-a.vol);
console.log("TOP 22 SPOT PAIRS BY dayNtlVlm (name-joined, from spotMetaAndAssetCtxs)");
console.log("pair       base   quote   spotVol24h$   perp?  perpVol24h$   spot/perp");
for(const r of rows.slice(0,22)){
 const perpName = r.base.replace(/^U/,"")==="BTC"?"BTC":null;
 const guess = {UBTC:"BTC",UETH:"ETH",USOL:"SOL",UZEC:"ZEC",UPUMP:"PUMP",UXPL:"XPL",UENA:"ENA",UFART:"FARTCOIN",HYPE:"HYPE",PURR:"PURR",UDOGE:"DOGE",XAUT0:null,USDT0:null,USDE:null,USDH:null}[r.base]||r.base;
 const p=pctx[guess];
 console.log(`${r.name.padEnd(10)} ${String(r.base).padEnd(6)} ${String(r.quote).padEnd(6)} ${(r.vol/1e6).toFixed(2).padStart(11)}M  ${p?guess.padEnd(6):"  -   "} ${p?((+p.dayNtlVlm)/1e6).toFixed(1).padStart(11)+"M":"           -"} ${p?(r.vol/+p.dayNtlVlm).toFixed(3).padStart(8):""}`);
}
const tot=rows.reduce((s,r)=>s+r.vol,0);
console.log(`\nspot pairs=${rows.length}, >$1M/day=${rows.filter(r=>r.vol>1e6).length}, >$100k/day=${rows.filter(r=>r.vol>1e5).length}, total spot 24h $${(tot/1e6).toFixed(0)}M`);
const ptot=pc.reduce((s,c)=>s+ +c.dayNtlVlm,0);
console.log(`perp total 24h $${(ptot/1e6).toFixed(0)}M -> spot is ${(100*tot/ptot).toFixed(1)}% of perp volume`);
// funding live
console.log("\nlive funding (from metaAndAssetCtxs):");
for(const c of ["HYPE","BTC","ETH","SOL","ZEC","PUMP","XPL","ENA","PURR"]){const p=pctx[c];if(!p)continue;
 console.log(`  ${c.padEnd(5)} funding=${p.funding} => ${(+p.funding*8760*100).toFixed(2)}%/yr  premium=${p.premium} oi=$${((+p.openInterest)*(+p.markPx)/1e6).toFixed(1)}M`);}
