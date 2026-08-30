import { TOKS, marketHours } from "./truth-skept-9-core.mjs";
const YR=3600*8760;
// 1) тождество, 2) кто плательщик, 3) стена
let n=0,ok=0,worst=0,worstT="",bad=0;
let minPickWrong=0, minPickN=0, bothZero=0, oneZero=0, sameSign=0;
let wallMax=0, wallTok="", wallH=0;
const perTok=[];
for(const t of TOKS){
  const M=marketHours(t); if(!M){console.log("НЕТ ДАННЫХ",t);continue;}
  let tn=0,tok_=0,tw=0, twall=0, twallH=0;
  for(const r of M){
    const al=Math.abs(r.fl), as=Math.abs(r.fs);
    if(al===0&&as===0){bothZero++;continue;}
    if(al===0||as===0){oneZero++;continue;}
    if(Math.sign(r.fl)===Math.sign(r.fs)) sameSign++;
    if(r.bl>0&&r.bs>0){
      const L=al*r.bl, S=as*r.bs;
      const rel=Math.abs(L-S)/Math.max(L,S);
      n++;tn++;
      if(rel<1e-4){ok++;tok_++;} else bad++;
      if(rel>worst){worst=rel;worstT=t+" "+new Date(r.h*1000).toISOString();}
      // ПЛАТЕЛЬЩИК = сторона с БОЛЬШЕЙ базой. Совпадает ли с min|ставка|?
      minPickN++;
      const payerIsLong = r.bl>r.bs;
      const minIsLong = al<as;
      if(payerIsLong!==minIsLong) minPickWrong++;
      const payRate = payerIsLong?al:as;
      if(payRate>twall){twall=payRate;twallH=r.h;}
    }
  }
  if(twall>wallMax){wallMax=twall;wallTok=t;wallH=twallH;}
  perTok.push({t,tn,frac:tok_/tn,wall:twall,wallH:twallH});
}
console.log("ТОЖДЕСТВО |f_long|*bl == |f_short|*bs");
console.log("часов проверено", n, "держится(<1e-4)", ok, (100*ok/n).toFixed(4)+"%", "не держится", bad);
console.log("худшая относительная ошибка", worst.toExponential(3), "у", worstT);
console.log("часов где обе ставки 0:", bothZero, " ровно одна 0:", oneZero, " одинаковый знак у обеих:", sameSign);
console.log("\nКТО ПЛАТЕЛЬЩИК: расхождений между 'большая база' и 'меньшая |ставка|':", minPickWrong, "из", minPickN,
  "("+(100*minPickWrong/minPickN).toFixed(4)+"%)");
console.log("\nСТЕНА (max ставки ПЛАТЕЛЬЩИКА, плательщик определён по БОЛЬШЕЙ БАЗЕ, не по min):");
console.log("глобальный максимум", wallMax.toExponential(5), "=", (wallMax*YR*100).toFixed(2)+"% годовых у", wallTok, new Date(wallH*1000).toISOString());
perTok.sort((a,b)=>b.wall-a.wall);
console.log("\nтоп-12 стен по рынкам:");
for(const p of perTok.slice(0,12)) console.log(" ",p.t.padEnd(9),p.wall.toExponential(4),(p.wall*YR*100).toFixed(2).padStart(8)+"%",new Date(p.wallH*1000).toISOString());
console.log("медиана стены по 63 рынкам:", (perTok[Math.floor(perTok.length/2)].wall*YR*100).toFixed(2)+"%");
