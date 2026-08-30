import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
import {med} from "./imp-hl-3-curve.mjs";
const SP=STUDY_DATA;
const P=JSON.parse(fs.readFileSync(`${SP}/imp-hl-paired.json`,"utf8"));
// поглощение по одному стакану (уровни как есть)
function vwapFor(lv,X){let need=X,c=0,n=0;for(const [px,sz] of lv){const d=px*sz;const t=Math.min(need,d);c+=t*px;n+=t;need-=t;if(need<=1e-9)break;}return need>1e-9?null:c/n;}
function solveN(lv,targetPx,side){ // ноционал, при котором VWAP достигает targetPx
  const f=(N)=>{const v=vwapFor(lv,N);return v==null?null:v;};
  let lo=1,hi=3e6;
  const cmp=(v)=>side==="asks"? v<=targetPx : v>=targetPx;
  if(!cmp(f(lo)??Infinity)) return null;
  const hv=f(hi); if(hv!=null&&cmp(hv)) return null;
  for(let i=0;i<50;i++){const m=(lo+hi)/2;const v=f(m);if(v!=null&&cmp(v))lo=m;else hi=m;}
  return lo;
}
const rows=[];
for(const [t,d] of Object.entries(P)){
  const mid=+d.ctx.midPx, [ib,ia]=d.ctx.impactPxs.map(Number);
  const bookMid=(d.bids[0][0]+d.asks[0][0])/2;
  rows.push({t,lev:d.lev,mid,bookMid,drift:(bookMid/mid-1)*1e4,
    impAskBps:(ia/mid-1)*1e4, impBidBps:(1-ib/mid)*1e4,
    nAsk:solveN(d.asks5,ia,"asks"), nBid:solveN(d.bids5,ib,"bids")});
}
console.log("расхождение середины стакана и midPx из ctx (парный снимок): медиана",
  med(rows.map(r=>Math.abs(r.drift))).toFixed(3),"бп -> снимки согласованы");
const ok=rows.filter(r=>r.nAsk&&r.nBid);
console.log("монет, где impactPx достижим внутри 20 уровней:",ok.length,"из",rows.length);
console.log();
console.log("lev   n   мед N(ask)$   мед N(bid)$   20000/lev   отношение");
const byLev=new Map(); for(const r of ok){(byLev.get(r.lev)??byLev.set(r.lev,[]).get(r.lev)).push(r);}
for(const [lev,g] of [...byLev].sort((a,b)=>b[0]-a[0])){
  const ma=med(g.map(r=>r.nAsk)), mb=med(g.map(r=>r.nBid)), th=20000/lev;
  console.log(String(lev).padEnd(5),String(g.length).padEnd(3),
    Math.round(ma).toLocaleString("en").padStart(12),Math.round(mb).toLocaleString("en").padStart(13),
    Math.round(th).toLocaleString("en").padStart(11),((ma+mb)/2/th).toFixed(2).padStart(10));
}
console.log();
const allR=ok.map(r=>((r.nAsk+r.nBid)/2)/(20000/r.lev));
console.log("отношение подобранного N к 20000/lev по всем монетам: медиана",med(allR).toFixed(2),
  " 25%",med(allR.filter(x=>x<=med(allR))).toFixed(2)," 75%",med(allR.filter(x=>x>=med(allR))).toFixed(2));
fs.writeFileSync(`${SP}/imp-hl-fit.json`,JSON.stringify(rows,null,1));
