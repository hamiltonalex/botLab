// Проба данных перед оптимизацией: покрытие снимков OI, валидность баз, скорость движка.
import { oiTokens, loadRows, loadOi, openPosition, accrueFromRows, closePosition, positionSummary, scanTwoLeg } from "./indep-lib.mjs";
const HOUR_MS=3600e3;
let toks=[], miss=0, badBase=0, tot=0, recvHours=0, payHours=0, resid=[];
for(const t of oiTokens){
  const rows=loadRows(t); if(!rows||rows.length!==8761) continue;
  const oi=loadOi(t); toks.push(t);
  const cfg=scanTwoLeg(rows,{token:t}).chosen, side=cfg==="A"?"short":"long";
  for(const r of rows){ tot++;
    const s=oi.get(r.tsHour); if(!s){miss++;continue;}
    if(!(s.bl>0&&s.bs>0)){badBase++;continue;}
    const fX=side==="short"?r.f_short:r.f_long;
    if(fX>0) recvHours++; else if(fX<0) payHours++;
    const a=Math.abs(r.f_long)*s.bl, b=Math.abs(r.f_short)*s.bs;
    if(a>0&&b>0) resid.push(Math.abs(a-b)/Math.max(a,b));
  }
}
resid.sort((x,y)=>x-y);
console.log("рынков с полным годом и снимками:",toks.length);
console.log("часов всего",tot,"без снимка",miss,(100*miss/tot).toFixed(3)+"%","база<=0",badBase,(100*badBase/tot).toFixed(3)+"%");
console.log("часы получения",recvHours,"часы оплаты",payHours,"доля оплаты",(100*payHours/(recvHours+payHours)).toFixed(2)+"%");
console.log("невязка тождества: медиана",(100*resid[resid.length>>1]).toExponential(2)+"%","p99",(100*resid[Math.floor(0.99*resid.length)]).toExponential(2)+"%","макс",(100*resid[resid.length-1]).toExponential(2)+"%");
// скорость движка
const rows=loadRows(toks[0]); const t0=Date.now(); let n=0;
for(let k=0;k<20;k++){ const p=openPosition({strategy:"two",instrumentKey:"x",config:"A",capital:1000,leverage:1,nowMs:rows[0].tsHour*1000,roundTripCost:0});
  const end=rows[rows.length-1].tsHour*1000+HOUR_MS; accrueFromRows(p,rows,end); closePosition(p,end); n+=rows.length; }
console.log("движок:",(n/((Date.now()-t0)/1000)/1e6).toFixed(2),"млн часо-шагов/сек");
console.log(JSON.stringify(toks));
