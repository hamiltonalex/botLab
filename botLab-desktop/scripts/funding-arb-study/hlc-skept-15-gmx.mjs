import * as L from "./hlc-skept-lib.mjs";
const TOP20=["TRUMP","FARTCOIN","HYPE","LINK","AAVE","PENDLE","UNI","NEAR","CRV","LTC","TAO","ETH","BTC","ONDO","DOGE","BNB","FET","SUI","AVAX","ARB"];
console.log("НОГА GMX (лонг, конфиг B) по движку, котируемая ставка, %/год от $10k");
let f=0,b=0,c=0;
console.log("монета   фандинг   борроу    итого GMX");
for(const t of TOP20){
  const rows=L.all.get(t); if(!rows) continue;
  const r=L.runLeg(rows,"B",10000);
  let fu=0,bo=0; for(const a of r.accruals){ fu+=a.fundingUsd||0; bo+=a.borrowUsd||0; }
  const k=8760/r.hours/10000;
  console.log(`${t.padEnd(9)} ${L.pc(fu*k).padStart(8)} ${L.pc(bo*k).padStart(9)} ${L.pc((fu+bo)*k).padStart(10)}`);
  f+=fu*k; b+=bo*k; c++;
}
console.log(`СРЕДНЕЕ по ${c}: фандинг ${L.pc(f/c)}, БОРРОУ ${L.pc(b/c)}, итого ${L.pc((f+b)/c)}  <- замер 3 заявлял борроу -8.97%`);
