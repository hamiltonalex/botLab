import fs from "node:fs";
const D="bas-a-candles";
const raw=(b,t,iv)=>JSON.parse(fs.readFileSync(`${D}/${b}_${t}_${iv}.json`,"utf8"));
const q=(a,p)=>{const i=(a.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return a[lo]+(a[hi]-a[lo])*(i-lo);};
const cands=JSON.parse(fs.readFileSync("bas-a-cands.json","utf8"));
const ser=(b,iv)=>{const S=new Map(raw(b,"spot",iv).map(r=>[r[0],r])),P=new Map(raw(b,"perp",iv).map(r=>[r[0],r]));
 const o=[];for(const t of [...S.keys()].sort((x,y)=>x-y)){const s=S.get(t),p=P.get(t);if(!p||s[6]<3||p[6]<3||!(s[4]>0))continue;o.push({t,b:1e4*(p[4]-s[4])/s[4]});}return o;};
const ru=a=>{let lo=Infinity,w=0,at=null;for(const v of a){if(v.b<lo)lo=v.b;if(v.b-lo>w){w=v.b-lo;at=v.t;}}return {w,at};};
console.log("=== resolution ladder: worst adverse basis run-up in each API window ===");
console.log("coin    1m(3.5d)  5m(17d)  15m(52d)   1h(208d)   1d(life)   | 15m p99 |b|  1h p99 |b|");
for (const c of cands){
  const L={}; for (const iv of ["1m","5m","15m","1h"]) L[iv]=ser(c.base,iv);
  // 1d with >=100 trades
  const S=new Map(raw(c.base,"spot","1d").map(r=>[r[0],r])),P=new Map(raw(c.base,"perp","1d").map(r=>[r[0],r]));
  const d=[];for(const t of [...S.keys()].sort((a,b)=>a-b)){const s=S.get(t),p=P.get(t);if(!p||s[6]<100||p[6]<100||!(s[4]>0))continue;d.push({t,b:1e4*(p[4]-s[4])/s[4]});}
  const f=(x)=>x.length>50?ru(x).w.toFixed(0):"--";
  const ab=(x)=>{const s=x.map(v=>Math.abs(v.b)).sort((a,b)=>a-b);return s.length>50?q(s,.99).toFixed(0):"--";};
  console.log(`${c.base.padEnd(7)}${f(L["1m"]).padStart(8)}${f(L["5m"]).padStart(9)}${f(L["15m"]).padStart(10)}${f(L["1h"]).padStart(11)}${f(d).padStart(11)}   |${ab(L["15m"]).padStart(9)} ${ab(L["1h"]).padStart(10)}`);
}
console.log("\n=== biggest 15m adverse episodes (52 days, finest resolution that spans a month) ===");
for (const c of ["HYPE","UBTC","UETH","USOL","UZEC"]){
  const s=ser(c,"15m"); if(s.length<100)continue;
  const so=[...s].sort((a,b)=>a.b-b.b);
  console.log(`${c.padEnd(6)} n=${s.length} min=${so[0].b.toFixed(1)}bp @${new Date(so[0].t).toISOString().slice(0,16)}  max=${so[so.length-1].b.toFixed(1)}bp @${new Date(so[so.length-1].t).toISOString().slice(0,16)}  worstRunUp=${ru(s).w.toFixed(1)}bp ending ${new Date(ru(s).at).toISOString().slice(0,16)}`);
}
