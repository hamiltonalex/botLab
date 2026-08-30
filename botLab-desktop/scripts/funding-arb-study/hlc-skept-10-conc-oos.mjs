import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
// КОНЦЕНТРАЦИЯ: их способ (по всем 93, включая монеты с отрицательным итогом)
const c93=[],c57=[];
for(const [t,rows] of L.all){
  const v=rows.map(r=>r.hl_rate), tot=v.reduce((a,b)=>a+b,0), n=v.length;
  const s=[...v].sort((a,b)=>b-a);
  const top=(f)=>s.slice(0,Math.max(1,Math.round(n*f))).reduce((a,b)=>a+b,0)/tot;
  const o={t,c1:top(0.01),c5:top(0.05),c10:top(0.10),tot};
  c93.push(o); if(tot>0) c57.push(o);
}
const m=(a,k)=>L.q(a.map(x=>x[k]),0.5);
console.log(`КОНЦЕНТРАЦИЯ`);
console.log(`  по всем 93 (как в замере 1): top1% ${(100*m(c93,"c1")).toFixed(1)}%, top5% ${(100*m(c93,"c5")).toFixed(1)}%, top10% ${(100*m(c93,"c10")).toFixed(1)}%`);
console.log(`  только по 57 плюсовым:      top1% ${(100*m(c57,"c1")).toFixed(1)}%, top5% ${(100*m(c57,"c5")).toFixed(1)}%, top10% ${(100*m(c57,"c10")).toFixed(1)}%`);
const bad=c93.filter(x=>x.tot<=0);
console.log(`  ВНИМАНИЕ: у ${bad.length} монет годовой итог <= 0, доля top-N у них не имеет смысла (делим на отрицательное/около нуля). Их значения top10%: ${bad.slice(0,5).map(x=>(100*x.c10).toFixed(0)+"%").join(", ")}...`);
// БЕЗ базы: концентрация ПРЕМИАЛЬНОЙ части (то, что реально рыночное)
const cp=[]; for(const [t,rows] of L.all){ const v=rows.map(r=>r.hl_rate-1.25e-5); const tot=v.reduce((a,b)=>a+b,0); if(tot<=0) continue;
  const s=[...v].sort((a,b)=>b-a),n=v.length; cp.push({c1:s.slice(0,Math.round(n*0.01)).reduce((a,b)=>a+b,0)/tot,c10:s.slice(0,Math.round(n*0.1)).reduce((a,b)=>a+b,0)/tot}); }
console.log(`  премиальная часть отдельно (монет с плюсовой премией: ${cp.length}): top1% ${(100*L.q(cp.map(x=>x.c1),0.5)).toFixed(0)}%, top10% ${(100*L.q(cp.map(x=>x.c10),0.5)).toFixed(0)}%`);

// ВНЕ ВЫБОРКИ y2
console.log(`\nВНЕ ВЫБОРКИ (y2, ${L.y2.size} монет)`);
const oos=[];
for(const [t,rows] of L.y2){
  if(!rows||rows.length<1000) continue;
  const r=L.runLeg(rows,"B",10000); const apr=r.dHl/10000*(8760/r.hours);
  const y1=L.all.get(t); const r1=y1?L.runLeg(y1,"B",10000):null;
  const a1=r1?r1.dHl/10000*(8760/r1.hours):NaN;
  // разложение
  const base=1.25e-5*8760, prem=rows.reduce((s,x)=>s+x.hl_rate-1.25e-5,0)/rows.length*8760;
  const prem1=y1?y1.reduce((s,x)=>s+x.hl_rate-1.25e-5,0)/y1.length*8760:NaN;
  oos.push({t,h:r.hours,apr,a1,prem,prem1,t0:new Date(rows[0].tsHour*1000).toISOString().slice(0,10),t1:new Date(rows.at(-1).tsHour*1000).toISOString().slice(0,10)});
}
console.log(`медиана APR период 2 ${L.pc(L.q(oos.map(o=>o.apr),0.5))}, те же монеты в периоде 1 ${L.pc(L.q(oos.map(o=>o.a1).filter(Number.isFinite),0.5))}`);
console.log(`плюсовых: п2 ${oos.filter(o=>o.apr>0).length}/${oos.length}, п1 ${oos.filter(o=>o.a1>0).length}/${oos.length}`);
console.log(`премиальная часть медиана: п2 ${L.pc(L.q(oos.map(o=>o.prem),0.5))}, п1 ${L.pc(L.q(oos.map(o=>o.prem1).filter(Number.isFinite),0.5))}`);
console.log(`Спирмен рангов п1 против п2 = ${L.spearman(oos.map(o=>o.a1),oos.map(o=>o.apr)).toFixed(3)}`);
console.log(`длины рядов п2: ${Math.min(...oos.map(o=>o.h))}..${Math.max(...oos.map(o=>o.h))} ч; старты ${[...new Set(oos.map(o=>o.t0))].sort().slice(0,3).join(",")}...${[...new Set(oos.map(o=>o.t0))].sort().at(-1)}`);
console.log(`\nмонета  п1       п2      старт п2`);
for(const o of oos.sort((a,b)=>b.apr-a.apr)) console.log(`${o.t.padEnd(7)} ${L.pc(o.a1).padStart(8)} ${L.pc(o.apr).padStart(8)}  ${o.t0} (${o.h}ч)`);
