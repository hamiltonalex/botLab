import fs from "node:fs";
const D="bas-a-candles";
const raw=(b,t,iv)=>JSON.parse(fs.readFileSync(`${D}/${b}_${t}_${iv}.json`,"utf8"));
const cands=JSON.parse(fs.readFileSync("bas-a-cands.json","utf8"));
// rigorous UPPER bound on basis inside an hour: perpHigh vs spotLow (and lower bound perpLow vs spotHigh)
console.log("=== rigorous intrabar envelope of basis, 1h bars, 208 days (NOT simultaneous: it is an outer bound) ===");
console.log("coin    n     maxUpperBound_bp  minLowerBound_bp   worst adverse run-up using bounds");
for (const c of cands){
  const S=new Map(raw(c.base,"spot","1h").map(r=>[r[0],r])),P=new Map(raw(c.base,"perp","1h").map(r=>[r[0],r]));
  const ts=[...S.keys()].filter(t=>P.has(t)).sort((a,b)=>a-b);
  const hi=[],lo=[];
  for(const t of ts){const s=S.get(t),p=P.get(t);if(s[6]<3||p[6]<3||!(s[3]>0&&s[2]>0))continue;
    hi.push(1e4*(p[2]-s[3])/s[3]); lo.push(1e4*(p[3]-s[2])/s[2]);}
  if(hi.length<100)continue;
  // worst adverse: enter at the best (lowest possible) basis, exit at the worst (highest possible) later
  let l=Infinity,w=0; for(let i=0;i<hi.length;i++){ if(lo[i]<l)l=lo[i]; if(hi[i]-l>w)w=hi[i]-l; }
  console.log(`${c.base.padEnd(6)} ${String(hi.length).padStart(5)} ${Math.max(...hi).toFixed(0).padStart(16)} ${Math.min(...lo).toFixed(0).padStart(17)} ${w.toFixed(0).padStart(35)}`);
}
