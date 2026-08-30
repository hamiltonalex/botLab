import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const vol=JSON.parse(fs.readFileSync("vol63.json","utf8"));
const bin=JSON.parse(fs.readFileSync("hlc-bin-funding.json","utf8"));
const rows=[];
for(const [t,rr] of L.all){
  const v=vol[t]; if(!v||!v.length) continue;
  const dv=L.q(v.map(x=>x.ntl),0.5);
  const r=L.runLeg(rr,"B",10000); const apr=r.dHl/10000*(8760/r.hours);
  rows.push({t,dv,apr});
}
console.log(`Спирмен(керри HL, суточный оборот HL) по ${rows.length} монетам = ${L.spearman(rows.map(r=>r.apr),rows.map(r=>r.dv)).toFixed(3)}`);
const s=[...rows].sort((a,b)=>b.dv-a.dv);
const qn=Math.ceil(s.length/5);
for(let i=0;i<5;i++){ const g=s.slice(i*qn,(i+1)*qn); if(!g.length) continue;
  console.log(`  квинтиль оборота ${i+1} (медиана $${(L.q(g.map(x=>x.dv),0.5)/1e6).toFixed(1)}М/сут): медианный керри ${L.pc(L.q(g.map(x=>x.apr),0.5))}, плюсовых ${g.filter(x=>x.apr>0).length}/${g.length}`);
}
// то же для СПРЕДА против Binance (реализуемая величина)
const sp=[];
for(const [coin,o] of Object.entries(bin)){
  const hl=L.all.get(coin), v=vol[coin]; if(!hl||!v||!v.length) continue;
  const rr=o.rows; const dts=[]; for(let i=1;i<rr.length;i++)dts.push(rr[i][0]-rr[i-1][0]); dts.sort((a,b)=>a-b);
  const iv=dts[Math.floor(dts.length/2)]/3600000; const m=new Map();
  for(const [t,r] of rr){const e=Math.floor(t/3600000); for(let k=0;k<iv;k++) m.set(e-k,r/iv);}
  let d=0,n=0; for(const x of hl){const b=m.get(Math.floor(x.tsHour/3600)); if(b===undefined)continue; d+=x.hl_rate-b; n++;}
  if(n<4000) continue; sp.push({t:coin,dv:L.q(v.map(x=>x.ntl),0.5),sp:d/n*8760});
}
console.log(`\nСпирмен(спред HL-Binance, оборот HL) по ${sp.length} монетам = ${L.spearman(sp.map(r=>r.sp),sp.map(r=>r.dv)).toFixed(3)}`);
const s2=[...sp].sort((a,b)=>b.dv-a.dv); const q2=Math.ceil(s2.length/4);
for(let i=0;i<4;i++){const g=s2.slice(i*q2,(i+1)*q2); if(!g.length)continue;
  console.log(`  квартиль ${i+1} (медиана $${(L.q(g.map(x=>x.dv),0.5)/1e6).toFixed(1)}М/сут): медианный спред ${L.pc(L.q(g.map(x=>x.sp),0.5))}`);}
// доход в долларах при потолке "1% оборота"
console.log(`\nдоход при размере = 1% суточного оборота HL, ноги хеджа нет:`);
let tot=0; const top=[...rows].filter(r=>r.apr>0).sort((a,b)=>b.dv*b.apr-a.dv*a.apr);
for(const r of top.slice(0,10)) console.log(`  ${r.t.padEnd(9)} размер $${(r.dv*0.01/1e3).toFixed(0)}k x ${L.pc(r.apr)} = $${(r.dv*0.01*r.apr/1e3).toFixed(1)}k/год`);
for(const r of top) tot+=r.dv*0.01*r.apr;
console.log(`  ИТОГО по всем ${top.length} плюсовым монетам: $${(tot/1e6).toFixed(2)} млн/год при суммарном размере $${(top.reduce((s,r)=>s+r.dv*0.01,0)/1e6).toFixed(1)} млн`);
console.log(`\nто же ХЕДЖИРОВАННОЕ (спред HL-Binance), размер = 1% оборота HL:`);
let t2=0,s2s=0; const pos=sp.filter(r=>r.sp>0).sort((a,b)=>b.dv*b.sp-a.dv*a.sp);
for(const r of pos.slice(0,8)) console.log(`  ${r.t.padEnd(9)} $${(r.dv*0.01/1e3).toFixed(0)}k x ${L.pc(r.sp)} = $${(r.dv*0.01*r.sp/1e3).toFixed(1)}k/год`);
for(const r of pos){t2+=r.dv*0.01*r.sp; s2s+=r.dv*0.01;}
console.log(`  ИТОГО ${pos.length} монет: $${(t2/1e6).toFixed(2)} млн/год валом на размер $${(s2s/1e6).toFixed(1)} млн ноциналя одной ноги`);
console.log(`  на КАПИТАЛ (две ноги 1x): ${L.pc(t2/(2*s2s))}; за вычетом круга 0.19%/год и ставки по госбумагам 4%: ${L.pc(t2/(2*s2s)-0.0019/2-0.04)}`);
