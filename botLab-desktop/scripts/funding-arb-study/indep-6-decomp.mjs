// Откуда берутся доллары: GMX-фандинг / GMX-borrow / HL-фандинг. Разбор ЛЕДЖЕРА движка.
import { oiTokens, loadRows, loadOi, DEFAULT_COSTS, roundTripCost,
         openPosition, accrueFromRows, closePosition, positionSummary } from "./indep-lib.mjs";
const HOUR_MS=3600e3;
function diluteRows(rows,oi,side,S,mode){
  return rows.map(r=>{const s=oi.get(r.tsHour); if(!s)return r;
    const fX=side==="short"?r.f_short:r.f_long; if(!(fX>0))return r;
    const bX=side==="short"?s.bs:s.bl, bO=side==="short"?s.bl:s.bs;
    const pot=Math.max(Math.abs(r.f_long)*s.bl,Math.abs(r.f_short)*s.bs);
    const f2=(mode==="flip"&&bX+S>bO)?0:pot/(bX+S);
    return side==="short"?{...r,f_short:f2}:{...r,f_long:f2};});
}
function run(rows,cfg,S){
  const p=openPosition({strategy:"two",instrumentKey:"x",config:cfg,capital:S,leverage:1,nowMs:rows[0].tsHour*1000,roundTripCost:0});
  const end=rows[rows.length-1].tsHour*1000+HOUR_MS;
  accrueFromRows(p,rows,end); closePosition(p,end);
  let f=0,b=0,h=0; for(const a of p.accruals){f+=a.fundingUsd;b+=a.borrowUsd;h+=a.dPnlHl;}
  return {gross:positionSummary(p).grossPnl,f,b,h};
}
const SIZES=[1000,10000,100000,1000000];
console.log("рынок cfg    S      ВСЕГО     GMXфанд   GMXborrow   HLфанд   (режим pot)");
for(const t of ["BERA","SEI","APT","S","ANIME","PENGU","FET","RENDER","CRV","DOT"]){
  const rows=loadRows(t),oi=loadOi(t);
  for(const S of SIZES){
    let best=null;
    for(const [cfg,side] of [["A","short"],["B","long"]]){
      const rr=diluteRows(rows,oi,side,S,"pot");
      const d=run(rr,cfg,S); d.cfg=cfg;
      if(!best||d.gross>best.gross)best=d;
    }
    const rt=roundTripCost(DEFAULT_COSTS,S,false);
    console.log(`${t.padEnd(8)}${best.cfg}  ${String(S).padStart(8)}  ${(best.gross-rt).toFixed(0).padStart(9)}  ${best.f.toFixed(0).padStart(9)}  ${best.b.toFixed(0).padStart(9)}  ${best.h.toFixed(0).padStart(9)}`);
  }
}
