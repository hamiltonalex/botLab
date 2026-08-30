import fs from "node:fs";
const D="bas-a-candles";
const raw=(b,t,iv)=>{const f=`${D}/${b}_${t}_${iv}.json`;return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];};
const q=(a,p)=>{if(!a.length)return NaN;const i=(a.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return a[lo]+(a[hi]-a[lo])*(i-lo);};
const cands=JSON.parse(fs.readFileSync("bas-a-cands.json","utf8"));
const carry=JSON.parse(fs.readFileSync("bas-a-carry.json","utf8"));
const IVMS={"1m":60e3,"5m":300e3,"15m":900e3,"1h":3600e3,"1d":86400e3};
const MINTR=3; // both books must have >=3 trades in the bar (kills stale prints)
function series(b,iv){
  const S=new Map(raw(b,"spot",iv).map(r=>[r[0],r])), P=new Map(raw(b,"perp",iv).map(r=>[r[0],r]));
  const out=[];
  for (const t of [...S.keys()].sort((x,y)=>x-y)){ const s=S.get(t),p=P.get(t); if(!p) continue;
    if (s[6]<MINTR||p[6]<MINTR) continue; if(!(s[4]>0&&p[4]>0)) continue;
    out.push({t, b:1e4*(p[4]-s[4])/s[4], sp:s[4], pp:p[4]}); }
  return out;
}
const REP={};
console.log("FILTER: both bars need >=%d trades\n",MINTR);
console.log("=== filtered basis, 1h (7 months) ===");
console.log("coin    n   kept%  med    q25    q75    p1      p99     min      max     sd   |b|>1% >2% >3% >5%   AR1  halfLife_h");
for (const c of cands){
  const s=series(c.base,"1h"); const all1h=raw(c.base,"spot","1h").length;
  if(s.length<100) {console.log(c.base,"too few bars",s.length); continue;}
  const bs=s.map(x=>x.b), sorted=[...bs].sort((a,b)=>a-b), n=bs.length;
  const mu=bs.reduce((a,b)=>a+b,0)/n, sd=Math.sqrt(bs.reduce((a,b)=>a+(b-mu)**2,0)/n);
  let num=0,den=0; for(let i=1;i<n;i++){num+=(bs[i]-mu)*(bs[i-1]-mu);} for(const v of bs)den+=(v-mu)**2;
  const ar1=num/den, hl=ar1>0&&ar1<1?Math.log(0.5)/Math.log(ar1):NaN;
  const cnt=x=>bs.filter(v=>Math.abs(v)>x).length/n;
  REP[c.base]={h1:{n,med:q(sorted,.5),sd,ar1,hl,mu}};
  console.log(`${c.base.padEnd(6)}${String(n).padStart(5)} ${(100*n/all1h).toFixed(0).padStart(4)}% ${q(sorted,.5).toFixed(1).padStart(6)} ${q(sorted,.25).toFixed(1).padStart(6)} ${q(sorted,.75).toFixed(1).padStart(6)} ${q(sorted,.01).toFixed(1).padStart(7)} ${q(sorted,.99).toFixed(1).padStart(7)} ${sorted[0].toFixed(1).padStart(8)} ${sorted[n-1].toFixed(1).padStart(8)} ${sd.toFixed(1).padStart(6)} ${(100*cnt(100)).toFixed(2).padStart(5)}%${(100*cnt(200)).toFixed(2).padStart(5)}%${(100*cnt(300)).toFixed(2).padStart(4)}%${(100*cnt(500)).toFixed(2).padStart(4)}% ${ar1.toFixed(3).padStart(6)} ${(hl||NaN).toFixed(2).padStart(6)}`);
}
// MAE over holding horizons using 1h series
console.log("\n=== MAX ADVERSE EXCURSION of (short perp + long spot) from basis alone, bp of notional ===");
console.log("   adverse = basis RISES after entry.  entry at every hour, horizon H hours, 1h series, 7 months");
console.log("coin    H=24h med/p95/max      H=168h med/p95/max      H=720h med/p95/max     worstEver(any entry->any later)");
const MAE={};
for (const c of cands){
  const s=series(c.base,"1h"); if(s.length<800) continue;
  const bs=s.map(x=>x.b);
  const line=[];
  const res={};
  for (const H of [24,168,720]){
    const m=[];
    for (let i=0;i+1<bs.length;i++){ let w=0; for(let j=i+1;j<Math.min(bs.length,i+1+H);j++) w=Math.max(w,bs[j]-bs[i]); m.push(w); }
    m.sort((a,b)=>a-b);
    res[H]={med:q(m,.5),p95:q(m,.95),max:m[m.length-1]};
    line.push(`${q(m,.5).toFixed(0).padStart(4)}/${q(m,.95).toFixed(0).padStart(4)}/${m[m.length-1].toFixed(0).padStart(5)}`);
  }
  // global worst run-up
  let lo=Infinity,worst=0; for(const v of bs){ if(v<lo)lo=v; if(v-lo>worst)worst=v-lo; }
  res.global=worst; MAE[c.base]=res;
  console.log(`${c.base.padEnd(6)} ${line.join("      ")}      ${worst.toFixed(0).padStart(6)}`);
}
fs.writeFileSync("bas-a-mae.json",JSON.stringify(MAE,null,1));
// vs carry
console.log("\n=== basis shock vs annual carry (engine, config B short HL, project year) ===");
console.log("coin  carryAPR%  1y carry bp   MAE 30d p95 bp  MAE 30d max bp  worstEver bp   worstEver / carry");
const MAP={HYPE:"HYPE",UBTC:"BTC",UETH:"ETH",USOL:"SOL",UZEC:"ZEC",UPUMP:"PUMP",UENA:"ENA",UXPL:"XPL"};
for (const c of cands){ const k=MAP[c.base]; const cr=carry[k]; const m=MAE[c.base]; if(!cr||!m) continue;
  const cb=1e4*cr.apr;
  console.log(`${c.base.padEnd(6)} ${(100*cr.apr).toFixed(2).padStart(8)}% ${cb.toFixed(0).padStart(11)} ${m[720].p95.toFixed(0).padStart(15)} ${m[720].max.toFixed(0).padStart(15)} ${m.global.toFixed(0).padStart(12)} ${(m.global/cb).toFixed(2).padStart(18)}x`);
}
