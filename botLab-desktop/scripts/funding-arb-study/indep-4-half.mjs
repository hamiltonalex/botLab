// Потолок потока и размер половинной ставки. Никакой стратегии - только денежная физика рынка.
import { oiTokens, loadRows, loadOi } from "./indep-lib.mjs";
const rows_ = {};
const out = [];
for (const t of oiTokens) {
  const rows = loadRows(t), oi = loadOi(t);
  if (!rows || rows.length !== 8761) continue;
  for (const side of ["short","long"]) {
    const H = []; // {pot$/h, base}
    for (const r of rows) {
      const s = oi.get(r.tsHour); if (!s) continue;
      const fX = side==="short"?r.f_short:r.f_long;
      if (!(fX>0)) continue;                       // получаем только когда знак ставки в нашу пользу
      const bX = side==="short"?s.bs:s.bl;
      const pot = Math.max(Math.abs(r.f_long)*s.bl, Math.abs(r.f_short)*s.bs)*3600; // $/час
      if (!(pot>0)) continue;
      H.push([pot,bX]);
    }
    if (!H.length) continue;
    const potYear = H.reduce((a,[p])=>a+p,0);      // весь фандинг, выплаченный на этом рынке за год ($)
    const rate0 = H.reduce((a,[p,b])=>a+(b>0?p/b:0),0); // доход на $1 при нулевом размере ($/год на $1)
    const rateAt = (S)=>H.reduce((a,[p,b])=>a+p/(b+S),0);
    // S, при котором ставка вдвое ниже котируемой
    let lo=1, hi=1e12;
    if (rateAt(1) < rate0/2) { lo=hi=0; }
    else { for(let k=0;k<200;k++){const m=Math.sqrt(lo*hi); if(rateAt(m)>rate0/2) lo=m; else hi=m;} }
    const Shalf = Math.sqrt(lo*hi);
    const bases = H.map(([,b])=>b).sort((a,b)=>a-b);
    out.push({t,side,hours:H.length,potYear,rate0,Shalf,medBase:bases[Math.floor(bases.length/2)]});
  }
}
out.sort((a,b)=>b.potYear-a.potYear);
console.log("рынок/нога  часов_получ  весь_фандинг_рынка_$/год  котир.ставка_$/год_на_$1  S_половины   медиана_базы_нашей_стороны");
for (const o of out.slice(0,25))
  console.log(`${(o.t+"/"+o.side).padEnd(14)} ${String(o.hours).padStart(5)}  $${o.potYear.toFixed(0).padStart(12)}  ${o.rate0.toFixed(2).padStart(10)}  $${o.Shalf.toFixed(0).padStart(10)}  $${o.medBase.toFixed(0).padStart(12)}`);
const tot = out.reduce((a,o)=>a+o.potYear,0);
console.log("\nвесь фандинг всех 63 рынков за год (обе стороны, двойной счёт по ногам): $"+tot.toFixed(0));
// половинный размер: распределение
const sh = out.map(o=>o.Shalf).sort((a,b)=>a-b);
console.log("S_половины по 126 ногам: медиана $"+sh[63].toFixed(0)+"  p25 $"+sh[31].toFixed(0)+"  p75 $"+sh[94].toFixed(0));
