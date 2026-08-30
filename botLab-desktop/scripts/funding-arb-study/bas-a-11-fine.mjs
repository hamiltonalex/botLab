import fs from "node:fs";
const D="bas-a-candles";
const raw=(b,t,iv)=>JSON.parse(fs.readFileSync(`${D}/${b}_${t}_${iv}.json`,"utf8"));
const q=(a,p)=>{const i=(a.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return a[lo]+(a[hi]-a[lo])*(i-lo);};
const cands=JSON.parse(fs.readFileSync("bas-a-cands.json","utf8"));
// A) 1m vs 1h over the SAME 3.5 days: how much does hourly sampling hide?
console.log("=== same window (last ~3.5d): 1m vs 1h extremes ===");
console.log("coin    1m: sd  min   max  worstRunUp | 1h: sd  min   max  worstRunUp | hidden factor");
for (const c of cands){
  const m=[], h=[];
  const S1=new Map(raw(c.base,"spot","1m").map(r=>[r[0],r])), P1=new Map(raw(c.base,"perp","1m").map(r=>[r[0],r]));
  let t0=Infinity,t1=0;
  for(const t of [...S1.keys()].sort((a,b)=>a-b)){const s=S1.get(t),p=P1.get(t);if(!p||s[6]<1||p[6]<1||!(s[4]>0))continue;
    m.push(1e4*(p[4]-s[4])/s[4]); t0=Math.min(t0,t); t1=Math.max(t1,t);}
  const Sh=new Map(raw(c.base,"spot","1h").map(r=>[r[0],r])), Ph=new Map(raw(c.base,"perp","1h").map(r=>[r[0],r]));
  for(const t of [...Sh.keys()].sort((a,b)=>a-b)){ if(t<t0||t>t1) continue; const s=Sh.get(t),p=Ph.get(t);if(!p||s[6]<1||p[6]<1||!(s[4]>0))continue; h.push(1e4*(p[4]-s[4])/s[4]);}
  const ru=a=>{let lo=Infinity,w=0;for(const v of a){if(v<lo)lo=v;if(v-lo>w)w=v-lo;}return w;};
  const sdf=a=>{const mu=a.reduce((x,y)=>x+y,0)/a.length;return Math.sqrt(a.reduce((x,y)=>x+(y-mu)**2,0)/a.length);};
  if(!m.length||!h.length)continue;
  console.log(`${c.base.padEnd(6)} ${sdf(m).toFixed(1).padStart(6)} ${Math.min(...m).toFixed(0).padStart(6)} ${Math.max(...m).toFixed(0).padStart(5)} ${ru(m).toFixed(0).padStart(8)}   | ${sdf(h).toFixed(1).padStart(5)} ${Math.min(...h).toFixed(0).padStart(6)} ${Math.max(...h).toFixed(0).padStart(5)} ${ru(h).toFixed(0).padStart(8)}   | ${(ru(m)/Math.max(ru(h),0.01)).toFixed(2)}x`);
}
// B) daily basis over full spot life, filtered by trade count
console.log("\n=== daily-close basis, full spot history, bars with >=100 trades both books ===");
console.log("coin    n  days  med   q25   q75    p1    p99    min    max    sd  worstRunUp  firstDay");
const dayRows={};
for (const c of cands){
  const S=new Map(raw(c.base,"spot","1d").map(r=>[r[0],r])), P=new Map(raw(c.base,"perp","1d").map(r=>[r[0],r]));
  const arr=[];
  for(const t of [...S.keys()].sort((a,b)=>a-b)){const s=S.get(t),p=P.get(t);if(!p||s[6]<100||p[6]<100||!(s[4]>0))continue;
    arr.push({t,b:1e4*(p[4]-s[4])/s[4]});}
  if(arr.length<30) {console.log(c.base.padEnd(6),"n="+arr.length,"(too short)");continue;}
  dayRows[c.base]=arr;
  const bs=arr.map(x=>x.b), so=[...bs].sort((a,b)=>a-b);
  const mu=bs.reduce((a,b)=>a+b,0)/bs.length, sd=Math.sqrt(bs.reduce((a,b)=>a+(b-mu)**2,0)/bs.length);
  let lo=Infinity,w=0;for(const v of bs){if(v<lo)lo=v;if(v-lo>w)w=v-lo;}
  console.log(`${c.base.padEnd(6)}${String(arr.length).padStart(4)} ${((arr[arr.length-1].t-arr[0].t)/864e5).toFixed(0).padStart(5)} ${q(so,.5).toFixed(1).padStart(5)} ${q(so,.25).toFixed(1).padStart(5)} ${q(so,.75).toFixed(1).padStart(5)} ${q(so,.01).toFixed(1).padStart(6)} ${q(so,.99).toFixed(1).padStart(6)} ${so[0].toFixed(1).padStart(6)} ${so[so.length-1].toFixed(1).padStart(6)} ${sd.toFixed(1).padStart(5)} ${w.toFixed(0).padStart(11)}  ${new Date(arr[0].t).toISOString().slice(0,10)}`);
}
// C) the 2025-10-10 stress day
console.log("\n=== stress day 2025-10-10 (HL liquidation cascade) daily-close basis ===");
for (const c of cands){ const a=dayRows[c.base]; if(!a) continue;
  for (const r of a) { const d=new Date(r.t).toISOString().slice(0,10);
    if(["2025-10-09","2025-10-10","2025-10-11","2025-10-12"].includes(d)) console.log(`${c.base.padEnd(6)} ${d} ${r.b.toFixed(1).padStart(8)}bp`); } }
