import { oiTokens, loadRows, loadOi } from "./indep-lib.mjs";
function legStats(t, side){
  const rows=loadRows(t), oi=loadOi(t); const H=[];
  for(const r of rows){const s=oi.get(r.tsHour); if(!s)continue;
    const fX=side==="short"?r.f_short:r.f_long; if(!(fX>0))continue;
    const bX=side==="short"?s.bs:s.bl, bO=side==="short"?s.bl:s.bs;
    const pot=Math.max(Math.abs(r.f_long)*s.bl,Math.abs(r.f_short)*s.bs)*3600;
    H.push({pot,bX,bO,apr:fX*3600*8760});}
  const potY=H.reduce((a,h)=>a+h.pot,0);
  const sorted=[...H].sort((a,b)=>b.pot-a.pot);
  const top1=sorted.slice(0,Math.ceil(H.length*0.01)).reduce((a,h)=>a+h.pot,0);
  const bs=H.map(h=>h.bX).sort((a,b)=>a-b);
  const bo=H.map(h=>h.bO).sort((a,b)=>a-b);
  return {hours:H.length,potY,top1pct:top1/potY,medOur:bs[bs.length>>1],medOther:bo[bo.length>>1],
    p10our:bs[Math.floor(bs.length*0.1)], maxApr:Math.max(...H.map(h=>h.apr))};
}
for (const [t,side] of [["BERA","short"],["BERA","long"],["SEI","short"],["APT","short"],["ANIME","short"],["PENGU","short"],["MOODENG","short"],["FET","short"]]) {
  const s=legStats(t,side);
  console.log(`${(t+"/"+side).padEnd(13)} часов=${String(s.hours).padStart(4)} потY=$${s.potY.toFixed(0).padStart(9)} доля_топ1%часов=${(100*s.top1pct).toFixed(0)}% медБаза_наша=$${s.medOur.toFixed(0).padStart(9)} p10=$${s.p10our.toFixed(0).padStart(8)} медБаза_чужая=$${s.medOther.toFixed(0).padStart(9)} maxAPR=${(100*s.maxApr).toFixed(0)}%`);
}
