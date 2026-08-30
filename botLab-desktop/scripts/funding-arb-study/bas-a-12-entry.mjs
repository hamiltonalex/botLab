import fs from "node:fs";
const D="bas-a-candles";
const raw=(b,t,iv)=>JSON.parse(fs.readFileSync(`${D}/${b}_${t}_${iv}.json`,"utf8"));
const q=(a,p)=>{const i=(a.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return a[lo]+(a[hi]-a[lo])*(i-lo);};
const cands=JSON.parse(fs.readFileSync("bas-a-cands.json","utf8"));
const ser=(b,iv,mt=3)=>{const S=new Map(raw(b,"spot",iv).map(r=>[r[0],r])),P=new Map(raw(b,"perp",iv).map(r=>[r[0],r]));
  const o=[];for(const t of [...S.keys()].sort((x,y)=>x-y)){const s=S.get(t),p=P.get(t);if(!p||s[6]<mt||p[6]<mt||!(s[4]>0))continue;o.push(1e4*(p[4]-s[4])/s[4]);}return o;};
// 1h-hides-vs-1d factor over the same 208d
console.log("=== resolution scaling of worst adverse run-up, same 208-day window ===");
console.log("coin    1h worstRunUp   1d worstRunUp   1h/1d");
for (const c of cands){
  const h=ser(c.base,"1h"); const Sd=new Map(raw(c.base,"spot","1d").map(r=>[r[0],r])),Pd=new Map(raw(c.base,"perp","1d").map(r=>[r[0],r]));
  const t0=Date.now()-208*864e5; const d=[];
  for(const t of [...Sd.keys()].sort((a,b)=>a-b)){if(t<t0)continue;const s=Sd.get(t),p=Pd.get(t);if(!p||s[6]<100||p[6]<100||!(s[4]>0))continue;d.push(1e4*(p[4]-s[4])/s[4]);}
  const ru=a=>{let lo=Infinity,w=0;for(const v of a){if(v<lo)lo=v;if(v-lo>w)w=v-lo;}return w;};
  if(h.length<100||d.length<50)continue;
  console.log(`${c.base.padEnd(6)} ${ru(h).toFixed(0).padStart(13)} ${ru(d).toFixed(0).padStart(15)} ${(ru(h)/Math.max(ru(d),.01)).toFixed(2).padStart(7)}x`);
}
// entry / exit economics on 1h series
console.log("\n=== ENTRY: basis you pay (bp of notional). adverse entry = basis HIGH ===");
console.log("coin    entry med  entry p75  entry p95  entry p99  entry max | value of waiting for b<=q25: medWait_h p90Wait_h gain_bp");
for (const c of cands){
  const b=ser(c.base,"1h"); if(b.length<500)continue;
  const so=[...b].sort((x,y)=>x-y); const q25=q(so,.25), med=q(so,.5);
  // waiting: from every hour, hours until b<=q25
  const waits=[]; for(let i=0;i<b.length;i++){let k=0;while(i+k<b.length&&b[i+k]>q25)k++; if(i+k<b.length)waits.push(k);}
  const ws=waits.sort((x,y)=>x-y);
  console.log(`${c.base.padEnd(6)} ${q(so,.5).toFixed(1).padStart(9)} ${q(so,.75).toFixed(1).padStart(10)} ${q(so,.95).toFixed(1).padStart(10)} ${q(so,.99).toFixed(1).padStart(10)} ${so[so.length-1].toFixed(1).padStart(10)} | ${q(ws,.5).toFixed(0).padStart(9)} ${q(ws,.9).toFixed(0).padStart(9)} ${(med-q25).toFixed(1).padStart(7)}`);
}
// realized basis P&L over a hold
console.log("\n=== REALIZED basis P&L of the round trip (enter t, exit t+H), bp of notional; +=gain ===");
console.log("coin      H=168h  med    p5    p95   | H=720h  med    p5    p95   | H=2160h(90d) med    p5    p95");
for (const c of cands){
  const b=ser(c.base,"1h"); if(b.length<2500)continue;
  const line=[];
  for (const H of [168,720,2160]){ const r=[]; for(let i=0;i+H<b.length;i++) r.push(b[i]-b[i+H]); r.sort((x,y)=>x-y);
    line.push(`${q(r,.5).toFixed(1).padStart(6)} ${q(r,.05).toFixed(1).padStart(6)} ${q(r,.95).toFixed(1).padStart(6)}`); }
  console.log(`${c.base.padEnd(6)} ${line.join("  |  ")}`);
}
