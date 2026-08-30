import fs from "node:fs";
const D="bas-a-candles";
const load=(b,t,iv)=>{ const f=`${D}/${b}_${t}_${iv}.json`; if(!fs.existsSync(f)) return null;
  const a=JSON.parse(fs.readFileSync(f,"utf8")); const m=new Map(); for(const r of a) m.set(r[0],{o:r[1],h:r[2],l:r[3],c:r[4],v:r[5],n:r[6]}); return m; };
const q=(a,p)=>{ if(!a.length) return NaN; const i=(a.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i); return a[lo]+(a[hi]-a[lo])*(i-lo); };
const cands=JSON.parse(fs.readFileSync("bas-a-cands.json","utf8"));
const IVMS={"1m":60e3,"5m":300e3,"15m":900e3,"1h":3600e3,"1d":86400e3};
const results={};
for (const c of cands){
  results[c.base]={};
  for (const iv of ["1m","1h","1d"]){
    const S=load(c.base,"spot",iv), P=load(c.base,"perp",iv);
    if(!S||!P) continue;
    const ts=[...S.keys()].filter(t=>P.has(t)).sort((a,b)=>a-b);
    if(ts.length<20) continue;
    const bas=[], series=[];
    for (const t of ts){ const s=S.get(t).c, p=P.get(t).c; if(!(s>0&&p>0)) continue;
      const b=1e4*(p-s)/s; bas.push(b); series.push({t,b,s,p,sv:S.get(t).v*s,pv:P.get(t).v*p, sn:S.get(t).n}); }
    const sorted=[...bas].sort((a,b)=>a-b);
    const n=bas.length;
    const cnt=(x)=>bas.filter(v=>Math.abs(v)>x).length;
    // dwell: runs of |b|>100bp (1%)
    const runs=[]; let cur=0;
    for (const v of bas){ if(Math.abs(v)>100) cur++; else { if(cur) runs.push(cur); cur=0; } }
    if(cur) runs.push(cur);
    // basis drawdown for short perp + long spot: PnL_t = -(basis_t - basis_0)/1e4 ... short perp gains when perp falls rel to spot
    // position pnl fraction of notional = (basis_0 - basis_t)/1e4
    let peak=-Infinity, mdd=0, mddUp=0, troughPeak=Infinity;
    for (const v of bas){ if(v>peak) peak=v; const dd=(peak-v); if(dd>mdd) mdd=dd;  // basis falling from a high = loss for LONG-basis; we need both directions
      if(v<troughPeak) troughPeak=v; const uu=(v-troughPeak); if(uu>mddUp) mddUp=uu; }
    results[c.base][iv]={n, spanDays:(ts[ts.length-1]-ts[0])/86400e3,
      med:q(sorted,0.5), q25:q(sorted,0.25), q75:q(sorted,0.75), p1:q(sorted,0.01), p99:q(sorted,0.99),
      min:sorted[0], max:sorted[n-1], maxAbs:Math.max(Math.abs(sorted[0]),Math.abs(sorted[n-1])),
      mean:bas.reduce((a,b)=>a+b,0)/n,
      sd:Math.sqrt(bas.reduce((a,b)=>a+b*b,0)/n - (bas.reduce((a,b)=>a+b,0)/n)**2),
      f100:cnt(100)/n, f200:cnt(200)/n, f300:cnt(300)/n, f500:cnt(500)/n,
      runsN:runs.length, runMax:runs.length?Math.max(...runs):0, runMed:runs.length?q([...runs].sort((a,b)=>a-b),0.5):0,
      barMs:IVMS[iv],
      maxFall:mdd, maxRise:mddUp,
      coverSpot:S.size, coverPerp:P.size, overlap:n };
    results[c.base][iv]._series = iv==="1m"?null:series;
  }
}
fs.writeFileSync("bas-a-basis.json", JSON.stringify(results,(k,v)=>k==="_series"?undefined:v,1));
// print
for (const iv of ["1m","1h","1d"]){
 console.log(`\n=== BASIS (perp-spot)/spot in bp, interval ${iv} ===`);
 console.log("coin     n     days   med    q25    q75     p1     p99    min     max   sd   >1%   >2%   >3%   >5%  maxFall maxRise");
 for (const c of cands){ const r=results[c.base]?.[iv]; if(!r) continue;
  const f=(x,w=6,d=1)=>Number(x).toFixed(d).padStart(w);
  console.log(`${c.base.padEnd(7)} ${String(r.n).padStart(5)} ${f(r.spanDays,6,1)} ${f(r.med)} ${f(r.q25)} ${f(r.q75)} ${f(r.p1)} ${f(r.p99,7)} ${f(r.min,7)} ${f(r.max,7)} ${f(r.sd,5)} ${(100*r.f100).toFixed(2).padStart(5)}%${(100*r.f200).toFixed(2).padStart(5)}%${(100*r.f300).toFixed(2).padStart(5)}%${(100*r.f500).toFixed(2).padStart(5)}% ${f(r.maxFall,7)} ${f(r.maxRise,7)}`);
 }
}
console.log("\n=== dwell above |1%| (bars / duration) ===");
for (const iv of ["1m","1h"]) for (const c of cands){ const r=results[c.base]?.[iv]; if(!r||!r.runsN) continue;
  console.log(`${iv} ${c.base.padEnd(7)} episodes=${String(r.runsN).padStart(4)} medDur=${(r.runMed*r.barMs/60000).toFixed(1)}min maxDur=${(r.runMax*r.barMs/60000).toFixed(1)}min`); }
