import fs from "node:fs";
const D="bas-a-candles";
const raw=(b,t,iv)=>JSON.parse(fs.readFileSync(`${D}/${b}_${t}_${iv}.json`,"utf8"));
const S=new Map(raw("UZEC","spot","5m").map(r=>[r[0],r])),P=new Map(raw("UZEC","perp","5m").map(r=>[r[0],r]));
const ts=[...S.keys()].filter(t=>P.has(t)).sort((a,b)=>a-b);
const rows=ts.map(t=>({t,s:S.get(t),p:P.get(t),b:1e4*(P.get(t)[4]-S.get(t)[4])/S.get(t)[4]}));
const i0=rows.findIndex(r=>r.t>=Date.parse("2026-08-21T07:00Z")), i1=rows.findIndex(r=>r.t>=Date.parse("2026-08-21T11:00Z"));
console.log("=== UZEC/ZEC dislocation 2026-08-21, 5m bars ===");
console.log("time              spotC     perpC   basis_bp  spotTrades perpTrades  spot5mVol$  perp5mVol$");
for (let i=i0;i<i1;i+=2){const r=rows[i];
 console.log(`${new Date(r.t).toISOString().slice(0,16)} ${String(r.s[4]).padStart(9)} ${String(r.p[4]).padStart(9)} ${r.b.toFixed(1).padStart(9)} ${String(r.s[6]).padStart(10)} ${String(r.p[6]).padStart(10)} ${Math.round(r.s[5]*r.s[4]).toLocaleString().padStart(11)} ${Math.round(r.p[5]*r.p[4]).toLocaleString().padStart(11)}`);}
// perp price change over the window
const a=rows[i0],b=rows[i1];
console.log(`\nperp moved ${(100*(b.p[4]/a.p[4]-1)).toFixed(1)}% and spot moved ${(100*(b.s[4]/a.s[4]-1)).toFixed(1)}% over the window`);
// how long did |basis|>100bp last that day
let cnt=0,max=0,cur=0;
for(const r of rows){ if(Math.abs(r.b)>100){cur++;cnt++;} else {max=Math.max(max,cur);cur=0;} }
console.log(`UZEC: 5m bars with |basis|>100bp: ${cnt} of ${rows.length} (${(100*cnt/rows.length).toFixed(2)}%), longest streak ${Math.max(max,cur)} bars = ${(Math.max(max,cur)*5)} min`);
