import {books,cap,knots,absorb,ctx,med} from "./imp-hl-3-curve.mjs";
// Подбираем ноционал N, при котором наш VWAP совпадает с impactPxs из metaAndAssetCtxs.
function solveN(kn,mid,side,targetPx){
  let lo=1, hi=5e6;
  const f=(N)=>{const r=absorb(kn,mid,N,side); return r.bps==null?1e9:(side==="asks"?r.bps:-r.bps);};
  const tgtBps = side==="asks" ? (targetPx/mid-1)*1e4 : -((1-targetPx/mid)*1e4);
  if(f(lo)>tgtBps) return {N:null,why:"уже на 1$ хуже цели"};
  if(f(hi)<tgtBps) return {N:null,why:"стакан не даёт такой цены"};
  for(let i=0;i<60;i++){const m=(lo+hi)/2; if(f(m)<=tgtBps) lo=m; else hi=m;}
  return {N:lo};
}
const rows=[];
for(const row of cap){
  const c=ctx.get(books[row.t].coin); if(!c||!c.impactPxs) continue;
  const bk=books[row.t].books, f=bk["null"];
  const mid=(f.bids[0][0]+f.asks[0][0])/2;
  const [impBid,impAsk]=c.impactPxs.map(Number);
  const na=solveN(knots(bk,"asks"),mid,"asks",impAsk);
  const nb=solveN(knots(bk,"bids"),mid,"bids",impBid);
  rows.push({t:row.t,lev:c.maxLeverage,mid,impAsk,impBid,
    nAsk:na.N,nBid:nb.N,
    devAsk:(impAsk/mid-1)*1e4, devBid:(1-impBid/mid)*1e4});
}
const ok=rows.filter(r=>r.nAsk&&r.nBid);
console.log("монет с решением:",ok.length,"из",rows.length);
console.log("медиана подобранного ноционала: ask $"+Math.round(med(ok.map(r=>r.nAsk))).toLocaleString("en"),
            " bid $"+Math.round(med(ok.map(r=>r.nBid))).toLocaleString("en"));
console.log();
console.log("по группам максимального плеча (HL: impact notional = 20000/leverage USD):");
const byLev=new Map();
for(const r of ok){ if(!byLev.has(r.lev))byLev.set(r.lev,[]); byLev.get(r.lev).push(r); }
console.log("lev  n   медиана N(ask)   медиана N(bid)   20000/lev");
for(const [lev,g] of [...byLev].sort((a,b)=>b[0]-a[0]))
  console.log(String(lev).padEnd(4),String(g.length).padEnd(3),
    Math.round(med(g.map(r=>r.nAsk))).toLocaleString("en").padStart(14),
    Math.round(med(g.map(r=>r.nBid))).toLocaleString("en").padStart(16),
    Math.round(20000/lev).toLocaleString("en").padStart(11));
console.log();
console.log("проверка гипотезы N=20000/lev: наш bps на этом N против bps из impactPxs");
console.log("token      lev   N$      наш_ask  их_ask   наш_bid  их_bid");
for(const t of ["BTC","ETH","SOL","AVAX","LINK","FARTCOIN","WIF","MOODENG","ANIME","BOME"]){
  const r=rows.find(x=>x.t===t); if(!r)continue;
  const bk=books[t].books; const N=20000/r.lev;
  const a=absorb(knots(bk,"asks"),r.mid,N,"asks"), b=absorb(knots(bk,"bids"),r.mid,N,"bids");
  console.log(t.padEnd(10),String(r.lev).padEnd(5),Math.round(N).toLocaleString("en").padStart(7),
    (a.bps==null?"OVER":a.bps.toFixed(2)).padStart(8),r.devAsk.toFixed(2).padStart(8),
    (b.bps==null?"OVER":b.bps.toFixed(2)).padStart(9),r.devBid.toFixed(2).padStart(8));
}
