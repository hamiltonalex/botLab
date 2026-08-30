import fs from "node:fs";
const D="bas-a-candles";
const load=(b,t,iv)=>{const a=JSON.parse(fs.readFileSync(`${D}/${b}_${t}_${iv}.json`,"utf8"));const m=new Map();for(const r of a)m.set(r[0],{o:r[1],h:r[2],l:r[3],c:r[4],v:r[5],n:r[6]});return m;};
for (const [b,iv,k] of [["UBTC","1d",6],["UETH","1d",6],["UENA","1d",6],["UZEC","1h",8],["PURR","1h",6],["HYPE","1d",6]]){
  const S=load(b,"spot",iv),P=load(b,"perp",iv);
  const rows=[...S.keys()].filter(t=>P.has(t)).sort((x,y)=>x-y)
    .map(t=>({t,s:S.get(t),p:P.get(t),bas:1e4*(P.get(t).c-S.get(t).c)/S.get(t).c}));
  rows.sort((x,y)=>Math.abs(y.bas)-Math.abs(x.bas));
  console.log(`\n--- ${b} ${iv}: ${k} largest |basis| ---`);
  for (const r of rows.slice(0,k))
    console.log(`${new Date(r.t).toISOString().slice(0,16)} basis=${r.bas.toFixed(1).padStart(9)}bp spotC=${r.s.c} spotTrades=${r.s.n} spotVolBase=${r.s.v} | perpC=${r.p.c} perpTrades=${r.p.n}`);
}
