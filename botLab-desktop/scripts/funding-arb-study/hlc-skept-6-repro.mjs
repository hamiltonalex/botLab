import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const res=[];
for(const [t,rows] of L.all){
  const r=L.runLeg(rows,"B",10000);
  const apr=r.dHl/10000*(8760/r.hours);
  const rA=L.runLeg(rows,"A",10000);
  res.push({t,h:r.hours,dHl:r.dHl,apr,ddHl:r.ddHl,mirror:Math.abs(rA.dHl+r.dHl)});
}
res.sort((a,b)=>b.apr-a.apr);
const aprs=res.map(r=>r.apr);
console.log(`ВОСПРОИЗВЕДЕНИЕ ЗАМЕРА 1 (движок, конфиг B, $10k, 93 монеты)`);
console.log(`медиана APR ${L.pc(L.q(aprs,0.5))}  Q1 ${L.pc(L.q(aprs,0.25))}  Q3 ${L.pc(L.q(aprs,0.75))}  плюсовых ${aprs.filter(a=>a>0).length}/93`);
console.log(`лучшая ${res[0].t} ${L.pc(res[0].apr)}  худшая ${res.at(-1).t} ${L.pc(res.at(-1).apr)}`);
console.log(`сумма $ по всем 93 (безусловный шорт) = $${res.reduce((s,r)=>s+r.dHl,0).toFixed(0)}`);
console.log(`нарушений зеркала A=-B: ${res.filter(r=>r.mirror>1e-9).length}`);
console.log(`>5%: ${aprs.filter(a=>a>0.05).length}  >10%: ${aprs.filter(a=>a>0.10).length}  >20%: ${aprs.filter(a=>a>0.20).length}`);
// база
let base=0,tot=0; for(const [t,rows] of L.all) for(const r of rows){tot++; if(Math.abs(r.hl_rate-1.25e-5)<1e-12) base++;}
console.log(`часов ровно на i=1.25e-5: ${(100*base/tot).toFixed(2)}% (${base}/${tot})`);
// разложение: база против премиальной части
const dec=[];
for(const [t,rows] of L.all){
  let b=0,p=0; for(const r of rows){ b+=1.25e-5; p+=r.hl_rate-1.25e-5; }
  const n=rows.length; dec.push({t,base:b/n*8760,prem:p/n*8760,tot:(b+p)/n*8760});
}
const pos=dec.filter(d=>d.tot>0);
console.log(`разложение: база всегда ${L.pc(1.25e-5*8760)}; премиальная часть медиана по 93 ${L.pc(L.q(dec.map(d=>d.prem),0.5))}, у 57 плюсовых ${L.pc(L.q(pos.map(d=>d.prem),0.5))}`);
console.log(`вклад базы в годовой керри у плюсовых, медиана = ${(100*L.q(pos.map(d=>d.base/d.tot),0.5)).toFixed(0)}%`);
// КОНЦЕНТРАЦИЯ независимо
const conc=[];
for(const [t,rows] of L.all){
  const v=rows.map(r=>r.hl_rate); const tot2=v.reduce((a,b)=>a+b,0); if(tot2<=0) continue;
  const s=[...v].sort((a,b)=>b-a); const n=v.length;
  const top=(f)=>s.slice(0,Math.max(1,Math.round(n*f))).reduce((a,b)=>a+b,0)/tot2;
  conc.push({t,c1:top(0.01),c5:top(0.05),c10:top(0.10)});
}
console.log(`концентрация (плюсовых ${conc.length}): медиана top1% ${(100*L.q(conc.map(c=>c.c1),0.5)).toFixed(1)}%, top5% ${(100*L.q(conc.map(c=>c.c5),0.5)).toFixed(1)}%, top10% ${(100*L.q(conc.map(c=>c.c10),0.5)).toFixed(1)}%`);
// корзины
function basket(list){
  let d=0,n=0,cum=[],per=10000;
  const len=Math.min(...list.map(t=>L.all.get(t).length));
  const series=list.map(t=>L.runLeg(L.all.get(t).slice(0,len),"B",per));
  const H=series[0].hours; const arr=new Array(H).fill(0);
  for(const s of series) s.accruals.forEach((a,i)=>{ if(i<H) arr[i]+=a.dPnlHl||0; });
  let c=0,peak=0,dd=0; const cs=[];
  for(const x of arr){ c+=x; cs.push(c); if(c>peak)peak=c; if(c-peak<dd)dd=c-peak; }
  const N=list.length*per;
  const w=(k)=>{ let worst=Infinity; for(let i=k;i<cs.length;i++) worst=Math.min(worst,cs[i]-cs[i-k]); return worst; };
  return {apr:c/N*(8760/H), dd, ddPct:Math.abs(dd)/N, w30:w(720), w90:w(2160), c, N, H};
}
const MAJ10=["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC"];
const full63=[...L.all.keys()].filter(t=>L.all.get(t).length===8761);
for(const [name,list] of [["10 мажоров",MAJ10],["BTC+ETH",["BTC","ETH"]],[`все ${full63.length} с полной историей`,full63]]){
  const b=basket(list);
  console.log(`корзина ${name}: APR ${L.pc(b.apr)}, просадка ноги $${b.dd.toFixed(0)} (${(100*b.ddPct).toFixed(2)}%), худшее 30д $${b.w30.toFixed(0)}, 90д $${b.w90.toFixed(0)}`);
}
fs.writeFileSync("hlc-skept-repro.json",JSON.stringify(res));
