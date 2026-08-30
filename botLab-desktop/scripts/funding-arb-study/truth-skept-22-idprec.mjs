import { TOKS, marketHours } from "./truth-skept-9-core.mjs";
const D18=["FET","S","MOODENG","BERA","FLOKI","EIGEN","WLD","STX","BONK","MEME","BOME","ORDI","TIA","LDO","WIF","AIXBT","INJ","POL"];
function scan(list,label){
  let n=0,worst=0,wt="",over=0;
  for(const t of list){ const M=marketHours(t); if(!M) continue;
    for(const r of M){ const al=Math.abs(r.fl),as=Math.abs(r.fs);
      if(!(al>0&&as>0&&r.bl>0&&r.bs>0)) continue;
      const L=al*r.bl,S=as*r.bs, rel=Math.abs(L-S)/Math.max(L,S);
      n++; if(rel>1e-9) over++;
      if(rel>worst){worst=rel;wt=t+" "+new Date(r.h*1000).toISOString();} } }
  console.log(label+": часов "+n.toLocaleString("ru-RU")+"  худшая отн.ошибка "+worst.toExponential(3)+" ("+(worst*100).toExponential(2)+"%) у "+wt+
    "   часов с ошибкой >1e-9: "+over);
}
scan(D18,"18 рынков части В");
scan(TOKS,"все 63 рынка   ");
scan(TOKS.filter(t=>!D18.includes(t)),"остальные 45  ");
