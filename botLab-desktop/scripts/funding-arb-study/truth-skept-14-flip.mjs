import { TOKS, marketHours } from "./truth-skept-9-core.mjs";
const YR=3600*8760;
// Точная арифметика GMX: ставка получателя = поток / база получателя.
// Вход размером N на сторону получателя: доля = N/(B_r+N) от потока.
// НО если B_r+N > B_p, вы становитесь БОЛЬШЕЙ стороной и платите сами.
console.log("РАЗБАВЛЕНИЕ И СМЕНА ЗНАКА. Вход N на принимающую сторону каждого из 63 рынков, каждый час.");
console.log("  N     валовой доход по модели   доход с разбавлением   доля часов со СМЕНОЙ ЗНАКА   доход, если считать смену знака платой");
for(const N of [1000,10000,50000,100000]){
  let naive=0, diluted=0, flipH=0, allH=0, dilFlip=0, netFlip=0, capital=0;
  for(const t of TOKS){
    const M=marketHours(t); if(!M) continue;
    for(const r of M){
      const al=Math.abs(r.fl),as=Math.abs(r.fs);
      if(!(al>0&&as>0&&r.bl>0&&r.bs>0)) continue;
      allH++;
      const payerIsLong=r.bl>r.bs;
      const pr=payerIsLong?al:as, pb=payerIsLong?r.bl:r.bs;
      const rr=payerIsLong?as:al, rb=payerIsLong?r.bs:r.bl;
      const flowH=pr*pb*3600;
      naive += rr*3600*N;                    // как книжит движок: ставка из кэша * ноционал
      const share=N/(rb+N);
      diluted += flowH*share;
      if(rb+N>pb){                            // мы стали большей стороной
        flipH++; dilFlip+=flowH*share;
        // после смены знака мы платим по ставке плательщика на свой размер (нижняя оценка: та же pr)
        netFlip += -pr*3600*N;
      } else netFlip += flowH*share;
    }
  }
  console.log(("$"+N.toLocaleString("ru-RU")).padStart(9),
    ("$"+Math.round(naive).toLocaleString("ru-RU")).padStart(22),
    ("$"+Math.round(diluted).toLocaleString("ru-RU")).padStart(22),
    ((100*flipH/allH).toFixed(1)+"%  ("+flipH.toLocaleString("ru-RU")+" из "+allH.toLocaleString("ru-RU")+")").padStart(30),
    ("$"+Math.round(netFlip).toLocaleString("ru-RU")).padStart(16),
    "  капитал $"+(N*63).toLocaleString("ru-RU"),
    " %год: наив "+(100*naive/(N*63)).toFixed(1)+"  разб "+(100*diluted/(N*63)).toFixed(1)+"  со сменой знака "+(100*netFlip/(N*63)).toFixed(1));
}
