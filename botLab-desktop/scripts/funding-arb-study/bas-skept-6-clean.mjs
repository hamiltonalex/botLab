import fs from "node:fs";
const ld=(c,iv)=>JSON.parse(fs.readFileSync(`bas-skept-c/${c.replace("@","at")}_${iv}.json`,"utf8"));
// inspect BTC/ETH 4h worst bars
for(const [perp,spot] of [["BTC","@142"],["ETH","@151"],["SOL","@156"]]){
  const P=ld(perp,"4h"),S=ld(spot,"4h");
  console.log(`\n--- ${perp} 4h: perp ${P.length} bars from ${new Date(P[0].t).toISOString().slice(0,10)}, spot ${S.length} bars from ${new Date(S[0].t).toISOString().slice(0,10)}`);
  const sm=new Map(S.map(r=>[r.t,r]));
  const rows=[];
  for(const p of P){const s=sm.get(p.t);if(!s)continue;rows.push({t:p.t,v:(+p.c-+s.c)/+s.c*1e4,sc:+s.c,pc:+p.c,sn:s.n,sv:+s.v,pn:p.n});}
  rows.sort((a,b)=>a.v-b.v);
  console.log("worst 5 (most negative):");
  for(const r of rows.slice(0,5))console.log("  ",new Date(r.t).toISOString().slice(0,13),"basis",r.v.toFixed(0),"spotC",r.sc,"perpC",r.pc,"spotN",r.sn,"spotV",r.sv);
  rows.sort((a,b)=>b.v-a.v);
  console.log("top 5 (most positive):");
  for(const r of rows.slice(0,5))console.log("  ",new Date(r.t).toISOString().slice(0,13),"basis",r.v.toFixed(0),"spotC",r.sc,"perpC",r.pc,"spotN",r.sn,"spotV",r.sv);
}
