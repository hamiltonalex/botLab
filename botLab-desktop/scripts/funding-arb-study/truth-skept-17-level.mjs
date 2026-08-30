import { TOKS, marketHours } from "./truth-skept-9-core.mjs";
const YR=3600*8760;
// УРОВНЕВОЕ разложение: log(ставка получателя) = log(ставка плательщика) + log(база плат / база получ)
const A=[],B=[];
for(const t of TOKS){
  const M=marketHours(t); if(!M) continue;
  for(const r of M){
    const al=Math.abs(r.fl),as=Math.abs(r.fs);
    if(!(al>0&&as>0&&r.bl>0&&r.bs>0)) continue;
    const pL=r.bl>r.bs;
    const o={pr:pL?al:as, rr:pL?as:al, ratio:(pL?r.bl:r.bs)/(pL?r.bs:r.bl)};
    (Math.max(al,as)>1e-7?A:B).push(o);
  }
}
const med=(a,f)=>{const s=a.map(f).sort((x,y)=>x-y);return s[Math.floor(s.length/2)];};
const mA=Math.log(med(A,x=>x.rr)), mB=Math.log(med(B,x=>x.rr));
const nA=Math.log(med(A,x=>x.pr)), nB=Math.log(med(B,x=>x.pr));
const dA=Math.log(med(A,x=>x.ratio)), dB=Math.log(med(B,x=>x.ratio));
console.log("УРОВНЕВОЕ РАЗЛОЖЕНИЕ ПРЕВЫШЕНИЯ (медианы, натуральные логарифмы)");
console.log("  ставка получателя: аномальные "+(Math.exp(mA)*YR*100).toFixed(0)+"% год, обычные "+(Math.exp(mB)*YR*100).toFixed(1)+"% год, превышение x"+Math.exp(mA-mB).toFixed(0));
console.log("  вклад ставки ПЛАТЕЛЬЩИКА:      x"+Math.exp(nA-nB).toFixed(2)+"   ("+(100*(nA-nB)/(mA-mB)).toFixed(1)+"% превышения)");
console.log("  вклад ОТНОШЕНИЯ БАЗ:           x"+Math.exp(dA-dB).toFixed(0)+"   ("+(100*(dA-dB)/(mA-mB)).toFixed(1)+"% превышения)");
console.log("  медианное отношение баз: аномальные "+med(A,x=>x.ratio).toFixed(1)+"   обычные "+med(B,x=>x.ratio).toFixed(2));

// ЗАМОРОЗКА: чем она объясняется механически
let fr=0, frBothBalEq=0, frRatioEq=0, mv=0, mvRatioEq=0;
for(const t of TOKS){
  const M=marketHours(t); if(!M) continue;
  for(let i=1;i<M.length;i++){
    const a=M[i-1],b=M[i];
    if(!(a.bl>0&&a.bs>0&&b.bl>0&&b.bs>0&&a.fl!==0&&b.fl!==0)) continue;
    const eqR=(a.fl===b.fl && a.fs===b.fs);
    const eqB=(a.bl===b.bl && a.bs===b.bs);
    const eqRatio=Math.abs((a.bl/a.bs)/(b.bl/b.bs)-1)<1e-12;
    if(eqR){fr++; if(eqB)frBothBalEq++; if(eqRatio)frRatioEq++;} else {mv++; if(eqRatio)mvRatioEq++;}
  }
}
console.log("\nМЕХАНИКА ЗАМОРОЗКИ (переходы час-к-часу, обе ставки ненулевые)");
console.log("  переходов, где ОБЕ ставки побитово те же: "+fr.toLocaleString("ru-RU"));
console.log("    из них обе базы тоже побитово те же: "+frBothBalEq.toLocaleString("ru-RU")+" ("+(100*frBothBalEq/fr).toFixed(1)+"%)");
console.log("    из них отношение баз не изменилось:  "+frRatioEq.toLocaleString("ru-RU")+" ("+(100*frRatioEq/fr).toFixed(1)+"%)");
console.log("  переходов, где ставка ИЗМЕНИЛАСЬ: "+mv.toLocaleString("ru-RU")+", из них отношение баз не менялось: "+(100*mvRatioEq/mv).toFixed(1)+"%");
