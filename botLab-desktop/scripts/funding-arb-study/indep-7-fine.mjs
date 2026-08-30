// Мелкая сетка размеров. Раздельно: ВЕСЬ нетто пары и ТОЛЬКО GMX-часть (фандинг минус borrow),
// потому что вопрос заказчика про раскачивание рынка GMX, а HL-нога в модели не разбавляется.
import fs from "node:fs";
import { oiTokens, loadRows, loadOi, DEFAULT_COSTS, roundTripCost, scanTwoLeg,
         openPosition, accrueFromRows, closePosition, positionSummary, SP } from "./indep-lib.mjs";
const HOUR_MS=3600e3;
const SIZES=[];for(let e=2;e<=6.0001;e+=0.125)SIZES.push(Math.round(10**e));
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
const out={};
for(const t of oiTokens){
  const rows=loadRows(t),oi=loadOi(t); if(!rows||rows.length!==8761)continue;
  const eng=scanTwoLeg(rows,{token:t}).chosen;
  out[t]={eng,rows:{}};
  for(const S of SIZES){
    const rt=roundTripCost(DEFAULT_COSTS,S,false);
    const cells={};
    for(const [cfg,side] of [["A","short"],["B","long"]]){
      for(const mode of ["pot","flip"]){
        const d=run(diluteRows(rows,oi,side,S,mode),cfg,S);
        cells[cfg+mode]=d;
      }
      cells[cfg+"none"]=run(rows,cfg,S);
    }
    out[t].rows[S]={rt,cells};
  }
}
fs.writeFileSync(`${SP}/indep-fine.json`,JSON.stringify({SIZES,out}));
console.log("ok",Object.keys(out).length,"sizes",SIZES.length);
