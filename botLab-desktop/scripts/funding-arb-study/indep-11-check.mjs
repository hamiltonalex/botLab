// Проверки самой модели: сходимость к неразбавленному при S->0, потолок потока, S_половины по всему портфелю.
import { oiTokens, loadRows, loadOi, scanTwoLeg } from "./indep-lib.mjs";
const H=[];
let potAll=0;
for(const t of oiTokens){
  const rows=loadRows(t),oi=loadOi(t); if(!rows||rows.length!==8761)continue;
  const cfg=scanTwoLeg(rows,{token:t}).chosen, side=cfg==="A"?"short":"long";
  for(const r of rows){const s=oi.get(r.tsHour); if(!s)continue;
    const fX=side==="short"?r.f_short:r.f_long; if(!(fX>0))continue;
    const bX=side==="short"?s.bs:s.bl;
    const pot=Math.max(Math.abs(r.f_long)*s.bl,Math.abs(r.f_short)*s.bs)*3600;
    if(!(pot>0)||!(bX>0))continue;
    H.push([pot,bX,fX*3600]); potAll+=pot;}
}
const quoted=(S)=>H.reduce((a,[,,f])=>a+f*S,0);
const real=(S)=>H.reduce((a,[p,b])=>a+p*S/(b+S),0);
console.log("Проверка сходимости (доля котируемого, которую реально получаем):");
for(const S of [0.01,1,100,1000,2000,5000,10000,50000,100000,1e6])
  console.log(`  S=$${String(S).padStart(9)}  получаем ${(100*real(S)/quoted(S)).toFixed(2)}%  деньги ${"$"+real(S).toFixed(0)}`);
console.log(`\nвесь фандинг, выплаченный на выбранных ногах 63 рынков за год: $${potAll.toFixed(0)}`);
console.log(`доход при S=$1e9 (весь поток наш): $${real(1e9).toFixed(0)}  <=  потолок $${potAll.toFixed(0)}  -> ${real(1e9)<=potAll*1.0000001?"ОК":"НАРУШЕНО"}`);
// S половины для портфеля в целом
const r0=H.reduce((a,[p,b])=>a+p/b,0);
let lo=1e-9,hi=1e12; for(let k=0;k<200;k++){const m=Math.sqrt(lo*hi); if(H.reduce((a,[p,b])=>a+p/(b+m),0)>r0/2)lo=m;else hi=m;}
console.log(`РАЗМЕР ПОЛОВИННОЙ СТАВКИ по портфелю (на один рынок): $${Math.sqrt(lo*hi).toFixed(0)}`);
