import fs from "node:fs"; import { SP } from "./indep-lib.mjs";
const res = JSON.parse(fs.readFileSync(`${SP}/indep-curve.json`,"utf8"));
const SIZES=[100,200,500,1000,2000,5000,10000,20000,50000,100000,200000,500000,1000000];
const f=(x)=> (x>=0?" ":"-")+"$"+Math.abs(x).toFixed(0).padStart(7);
// 1) агрегат по всем 63 рынкам: сумма лучших нетто при данном размере на рынок
console.log("== СУММА ПО ВСЕМ 63 РЫНКАМ (в каждом позиция размера S, лучший конфиг in-sample) ==");
console.log("S/рынок  капитал  без разбавл.   потолок(pot)   строгий(flip)  доля рынков>0(pot)");
for (const S of SIZES){
  let none=0,pot=0,flip=0,np=0;
  for(const r of res){const c=r.sizes[S]; none+=c.bestNone; pot+=c.bestPot; flip+=c.bestFlip; if(c.bestPot>0)np++;}
  console.log(`${String(S).padStart(7)} ${String(S*63).padStart(9)} ${f(none)} ${f(pot)} ${f(flip)}   ${np}/63`);
}
// 2) ТОП-10 рынков по нетто при S=10000 (pot)
const top=[...res].sort((a,b)=>b.sizes[10000].bestPot-a.sizes[10000].bestPot).slice(0,12);
console.log("\n== ТОП-12 рынков (сорт. по нетто при S=$10k, режим pot) ==");
console.log("рынок      "+SIZES.map(s=>String(s).padStart(9)).join(""));
for(const r of top){
  console.log(r.t.padEnd(10)+SIZES.map(s=>f(r.sizes[s].bestPot).padStart(9)).join(""));
}
// 3) те же рынки, режим flip
console.log("\n== те же рынки, строгий режим flip ==");
for(const r of top){
  console.log(r.t.padEnd(10)+SIZES.map(s=>f(r.sizes[s].bestFlip).padStart(9)).join(""));
}
// 4) без разбавления (что «котируется»)
console.log("\n== те же рынки, БЕЗ разбавления (котируемая ставка, фантазия) ==");
for(const r of top){
  console.log(r.t.padEnd(10)+SIZES.map(s=>f(r.sizes[s].bestNone).padStart(9)).join(""));
}
// 5) сумма по топ-10 портфелю
console.log("\n== ПОРТФЕЛЬ ТОП-10 (лучшие по S=$10k) ==");
const p10=top.slice(0,10);
for (const S of SIZES){
  let pot=0,flip=0,none=0; for(const r of p10){pot+=r.sizes[S].bestPot;flip+=r.sizes[S].bestFlip;none+=r.sizes[S].bestNone;}
  console.log(`S=${String(S).padStart(7)} капитал ${String(S*10).padStart(8)}  none ${f(none)}  pot ${f(pot)}  flip ${f(flip)}  APR(pot) ${(100*pot/(S*10)).toFixed(1)}%`);
}
