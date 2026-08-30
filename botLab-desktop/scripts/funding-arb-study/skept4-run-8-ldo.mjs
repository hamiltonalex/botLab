// 8. Что физически стоит за позицией, которая одна даёт 70% "жёсткого" ответа.
import { all, annualizeRow, median, maxOf } from "./skept-cap-lib.mjs";
const H=(x)=>(100*x).toFixed(0)+"%";
for (const [tok,i0,i1,cfg] of [["LDO",5040,5760,"A"],["S",2160,2880,"A"],["TIA",7920,8640,null]]) {
  const rows=all.get(tok); if(!rows) { console.log(tok+": нет данных"); continue; }
  const w=rows.slice(i0,i1).map(annualizeRow);
  const net=w.map(a=>cfg==="B"?a.net_B:a.net_A);
  const s=net.slice().sort((a,b)=>a-b);
  const top=net.map((v,i)=>({v,i})).sort((a,b)=>b.v-a.v);
  const sum=net.reduce((a,b)=>a+b,0);
  const top24=top.slice(0,24).reduce((a,b)=>a+b.v,0);
  const top72=top.slice(0,72).reduce((a,b)=>a+b.v,0);
  console.log(`\n## ${tok} окно ${i0}..${i1}, конфиг ${cfg||"A"}`);
  console.log(`  средняя net ставка ${H(sum/net.length)}, медиана ${H(median(net))}, макс ${H(maxOf(net))}, мин ${H(Math.min(...net))}`);
  console.log(`  доля часов с net>0: ${H(net.filter(x=>x>0).length/net.length)}`);
  console.log(`  вклад 24 лучших часов из ${net.length} в сумму: ${H(top24/sum)}; 72 лучших: ${H(top72/sum)}`);
  // разложение по источникам
  const c=(k)=>w.reduce((a,x)=>a+x[k],0)/w.length;
  console.log(`  источники (средние годовые): gmx_short_recv ${H(c("gmx_short_recv"))}, gmx_borrow_short ${H(c("gmx_borrow_short"))}, hl_long_recv ${H(c("hl_long_recv"))}`);
  console.log(`  то есть net_A = ${H(c("gmx_short_recv"))} - ${H(c("gmx_borrow_short"))} + ${H(c("hl_long_recv"))}`);
  const r=rows.slice(i0,i1);
  const fs=r.map(x=>x.f_short*3600*8760), hl=r.map(x=>-x.hl_rate*8760);
  console.log(`  ставка GMX f_short годовая: медиана ${H(median(fs))}, макс ${H(maxOf(fs))}`);
  console.log(`  плечо HL (лонг получает): медиана ${H(median(hl))}, макс ${H(maxOf(hl))}`);
  const big=top.slice(0,5).map(x=>`ч.${x.i} ${H(x.v)}`).join(", ");
  console.log(`  5 самых крупных часов: ${big}`);
}
