import { TOKS, marketHours } from "./truth-skept-9-core.mjs";
const MINF=3.1710e-10; // минимальный фактор фандинга протокола = 1% годовых
console.log("ВИЛКА ПО ЦЕНЕ СМЕНЫ ЗНАКА (N=$10 000 на каждый из 63 рынков, капитал $630 000)");
console.log("вариант                                              годовой итог      %год");
const N=10000;
let diluted=0, costLow=0, costHigh=0, flipShare=0, keepFlow=0;
for(const t of TOKS){
  const M=marketHours(t); if(!M) continue;
  for(const r of M){
    const al=Math.abs(r.fl),as=Math.abs(r.fs);
    if(!(al>0&&as>0&&r.bl>0&&r.bs>0)) continue;
    const pIsL=r.bl>r.bs;
    const pr=pIsL?al:as, pb=pIsL?r.bl:r.bs, rb=pIsL?r.bs:r.bl;
    const flowH=pr*pb*3600, share=N/(rb+N);
    diluted+=flowH*share;
    if(rb+N>pb){ flipShare+=flowH*share; costLow+=MINF*3600*N; costHigh+=pr*3600*N; }
    else keepFlow+=flowH*share;
  }
}
const cap=N*63;
const p=(v)=>("$"+Math.round(v).toLocaleString("ru-RU")).padStart(16)+"  "+(100*v/cap).toFixed(1).padStart(7)+"%";
console.log("модель бота (ставка кэша * ноционал)              ", p(2816537));
console.log("только разбавление (как в частях Б и В)           ", p(diluted));
console.log("часы без смены знака (доход остаётся)             ", p(keepFlow));
console.log("+ смена знака по МИНИМАЛЬНОЙ ставке протокола 1%  ", p(keepFlow-costLow));
console.log("+ смена знака по ставке плательщика того часа     ", p(keepFlow-costHigh));
console.log("\nдоход, который части Б и В приписали часам со сменой знака (он недостижим): $"+Math.round(flipShare).toLocaleString("ru-RU")+
  " = "+(100*flipShare/diluted).toFixed(1)+"% от их $"+Math.round(diluted).toLocaleString("ru-RU"));
