import { TOKS, marketHours } from "./truth-skept-9-core.mjs";
const YR=3600*8760;
// A. Разложение: почему ставка получателя большая - числитель (ставка плательщика) или знаменатель (база получателя)?
let vNum=0,vDen=0,n=0, cov=0;
const anomB=[], normB=[], anomPay=[], normPay=[];
for(const t of TOKS){
  const M=marketHours(t); if(!M) continue;
  for(let i=1;i<M.length;i++){
    const a=M[i-1],b=M[i];
    const f=(r)=>{const al=Math.abs(r.fl),as=Math.abs(r.fs);
      if(!(al>0&&as>0&&r.bl>0&&r.bs>0))return null;
      const pL=r.bl>r.bs; return {pr:pL?al:as, pb:pL?r.bl:r.bs, rr:pL?as:al, rb:pL?r.bs:r.bl};};
    const A=f(a),B=f(b); if(!A||!B) continue;
    const dR=Math.log(B.rr/A.rr), dNum=Math.log((B.pr*B.pb)/(A.pr*A.pb)), dDen=-Math.log(B.rb/A.rb);
    if(!isFinite(dR)||!isFinite(dNum)||!isFinite(dDen)) continue;
    vNum+=dNum*dR; vDen+=dDen*dR; n++;
  }
  for(const r of M){
    const al=Math.abs(r.fl),as=Math.abs(r.fs);
    if(!(al>0&&as>0&&r.bl>0&&r.bs>0)) continue;
    const pL=r.bl>r.bs, rb=pL?r.bs:r.bl, pr=pL?al:as;
    if(Math.max(al,as)>1e-7){anomB.push(rb);anomPay.push(pr);} else {normB.push(rb);normPay.push(pr);}
  }
}
const med=a=>{a=a.slice().sort((x,y)=>x-y);return a[Math.floor(a.length/2)];};
console.log("A. РАЗЛОЖЕНИЕ ИЗМЕНЕНИЯ СТАВКИ ПОЛУЧАТЕЛЯ (ковариационная доля, "+n.toLocaleString("ru-RU")+" переходов час-к-часу)");
console.log("   числитель (поток плательщика): "+(100*vNum/(vNum+vDen)).toFixed(1)+"%   знаменатель (база получателя): "+(100*vDen/(vNum+vDen)).toFixed(1)+"%");
console.log("\nB. ЧТО ОТЛИЧАЕТ АНОМАЛЬНЫЙ ЧАС");
console.log("   медиана базы получателя: аномальные $"+med(anomB).toFixed(2)+"   обычные $"+Math.round(med(normB)).toLocaleString("ru-RU")+
  "   отношение "+(med(normB)/med(anomB)).toExponential(2));
console.log("   медиана ставки ПЛАТЕЛЬЩИКА: аномальные "+(med(anomPay)*YR*100).toFixed(1)+"% год   обычные "+(med(normPay)*YR*100).toFixed(1)+"% год");
// C. Приходил ли капитал на ставку? Реакция базы получателя после начала аномалии
let ev=0; const g=[[],[],[],[]]; const base=[[],[],[],[]];
for(const t of TOKS){
  const M=marketHours(t); if(!M) continue;
  const F=M.map(r=>{const al=Math.abs(r.fl),as=Math.abs(r.fs);
    if(!(al>0&&as>0&&r.bl>0&&r.bs>0))return null;
    const pL=r.bl>r.bs; return {an:Math.max(al,as)>1e-7, rb:pL?r.bs:r.bl};});
  for(let i=1;i<F.length;i++){
    if(!F[i]||!F[i-1]) continue;
    if(F[i].an&&!F[i-1].an){
      ev++;
      [1,6,24,168].forEach((k,j)=>{ const q=F[i+k]; if(q) g[j].push(q.rb/F[i].rb); });
    }
    if(F[i]&&!F[i].an&&F[i-1]&&!F[i-1].an){
      [1,6,24,168].forEach((k,j)=>{ const q=F[i+k]; if(q&&!q.an) base[j].push(q.rb/F[i].rb); });
    }
  }
}
console.log("\nC. ПРИШЁЛ ЛИ КАПИТАЛ НА ОБЪЯВЛЕННУЮ ДОХОДНОСТЬ ("+ev.toLocaleString("ru-RU")+" начал аномальных эпизодов)");
console.log("   горизонт   медиана база(t+k)/база(t) ПОСЛЕ аномалии   то же в обычные часы (контроль)");
[1,6,24,168].forEach((k,j)=>console.log("   +"+String(k).padEnd(5)+"ч"+med(g[j]).toFixed(4).padStart(30)+med(base[j]).toFixed(4).padStart(38)));
