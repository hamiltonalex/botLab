import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const bin=JSON.parse(fs.readFileSync("hlc-bin-funding.json","utf8"));
const PX=JSON.parse(fs.readFileSync("hlc-skept-px-bin.json","utf8"));
const I=1e-4;
// почасовые ряды: HL ставка (через движок) и Binance ставка
const S=new Map();
for(const [coin,o] of Object.entries(bin)){
  const hl=L.all.get(coin); if(!hl||hl.length!==8761) continue;
  const rr=o.rows; const dts=[]; for(let i=1;i<rr.length;i++) dts.push(rr[i][0]-rr[i-1][0]); dts.sort((a,b)=>a-b);
  const iv=dts[Math.floor(dts.length/2)]/3600000;
  const m=new Map(); for(const [t,r] of rr){ const e=Math.floor(t/3600000); for(let k=0;k<iv;k++) m.set(e-k,r/iv); }
  const eng=L.runLeg(hl,"B",10000); // движок даёт dPnlHl по часам
  const hlA=eng.accruals.map(a=>a.dPnlHl||0);
  const bnA=hl.map(x=>{ const b=m.get(Math.floor(x.tsHour/3600)); return b===undefined?null:-b*10000; }); // лонг Binance платит +rate
  if(bnA.filter(x=>x===null).length>500) continue;
  S.set(coin,{hl:hlA,bn:bnA.map(x=>x===null?0:x)});
}
console.log(`монет с обеими ногами и полным годом: ${S.size}`);
const CB={...L.DEFAULT_COSTS}; // штатная модель
const rtPair=L.roundTripCost(L.DEFAULT_COSTS,10000,false);
const binCosts={...L.DEFAULT_COSTS, gmxOpen:0.05, gmxClose:0.05, gmxImpact:0, gmxGas:0};
const rtBin=L.roundTripCost(binCosts,10000,false);
console.log(`круг: штатный GMX+HL $${rtPair.toFixed(2)} (${(100*rtPair/10000).toFixed(3)}%), с параметрами Binance $${rtBin.toFixed(2)} (${(100*rtBin/10000).toFixed(3)}%)`);
const TRAIN=2160;
function run(N, reent){
  const cand=[...S.entries()].map(([t,s])=>({t, tr:s.hl.slice(0,TRAIN).reduce((a,b)=>a+b,0)+s.bn.slice(0,TRAIN).reduce((a,b)=>a+b,0)}))
    .sort((a,b)=>b.tr-a.tr).slice(0,N).map(x=>x.t);
  const len=8761-TRAIN, w=1/N; const arr=new Array(len).fill(0);
  for(const t of cand){ const s=S.get(t); for(let i=0;i<len;i++) arr[i]+=w*(s.hl[TRAIN+i]+s.bn[TRAIN+i]); }
  let c=0,peak=0,dd=0,p=[]; for(const x of arr){c+=x;p.push(c);if(c>peak)peak=c;if(c-peak<dd)dd=c-peak;}
  const yrs=len/8760;
  const costs = reent*yrs*rtBin; // $ на $10k ноциналя (все N монет вместе = $10k)
  const wq=(W)=>{let worst=Infinity;for(let i=0;i+W<=len;i+=24)worst=Math.min(worst,p[i+W-1]-p[i]);return worst;};
  return {cand,gross:c/10000/yrs, net:(c-costs)/10000/yrs, dd:dd/10000, w30:wq(720)/10000, yrs};
}
console.log(`\nВНЕ ВЫБОРКИ: отбор по спреду первых 90 дней, держим ${((8761-TRAIN)/24).toFixed(0)} дней`);
console.log(`N   монеты                          валовой   1 круг/год  12/год   26/год   52/год   просадка  худш.30д`);
for(const N of [5,10,20]){
  const r=run(N,1);
  const at=(k)=>L.pc(r.gross-k*(rtBin/10000)*1).padStart(8);
  console.log(`${String(N).padEnd(3)} ${r.cand.slice(0,5).join(",").padEnd(32)} ${L.pc(r.gross).padStart(8)} ${at(1)} ${at(12)} ${at(26)} ${at(52)} ${L.pc(r.dd).padStart(9)} ${L.pc(r.w30).padStart(8)}`);
}
console.log(`\nна КАПИТАЛ (обе ноги по 1x = 2x ноциналя), N=10, 1 круг/год: ${L.pc(run(10,1).net/2)}`);
console.log(`минус альтернативная доходность залога (короткие госбумаги ~4%): ${L.pc(run(10,1).net/2-0.04)}`);
