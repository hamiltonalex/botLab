// Разделить: (а) часы, где мы УЖЕ большая сторона и всё равно получаем (инерция), (б) часы,
// где именно НАШ вход делает нас большей стороной. Взвешено котируемыми деньгами, все 63 рынка.
import { oiTokens, loadRows, loadOi, scanTwoLeg } from "./indep-lib.mjs";
const SZ=[2000,5000,10000,100000];
const A={},B={},T={}; for(const s of SZ){A[s]=0;B[s]=0;T[s]=0;}
for(const t of oiTokens){
  const rows=loadRows(t),oi=loadOi(t); if(!rows||rows.length!==8761)continue;
  const cfg=scanTwoLeg(rows,{token:t}).chosen, side=cfg==="A"?"short":"long";
  for(const r of rows){const o=oi.get(r.tsHour); if(!o)continue;
    const fX=side==="short"?r.f_short:r.f_long; if(!(fX>0))continue;
    const bX=side==="short"?o.bs:o.bl, bO=side==="short"?o.bl:o.bs;
    for(const s of SZ){const q=fX*3600*s; T[s]+=q;
      if(bX>bO)A[s]+=q; else if(bX+s>bO)B[s]+=q;}}
}
console.log("размер | доля котируемых денег в часах, где мы УЖЕ большая сторона | где именно НАШ вход переворачивает | сумма");
for(const s of SZ)console.log(` $${String(s).padStart(6)}  ${(100*A[s]/T[s]).toFixed(1)}%   ${(100*B[s]/T[s]).toFixed(1)}%   ${(100*(A[s]+B[s])/T[s]).toFixed(1)}%`);
