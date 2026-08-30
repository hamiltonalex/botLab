// 9. Физика часовых ставок, которые платят за весь ответ.
import { all, annualizeRow } from "./skept-cap-lib.mjs";
import { CAP } from "./run4-lib.mjs";
const f=(x)=>"$"+Math.round(x).toLocaleString("en-US");
const toks=[...CAP.keys()];
let n=0; const buck=new Map();
const B=[1,3,10,30,100,300,1000,10000,Infinity];
const lbl=["<100%","100-300%","300-1000%","1000-3000%","3000-10000%","1e4-3e4%","3e4-1e5%","1e5-1e6%",">1e6%"];
let hrs=0, sum=0; const contrib=new Array(B.length).fill(0), cnt=new Array(B.length).fill(0);
for (const t of toks){ const r=all.get(t); if(!r) continue;
  for(const x of r){ const a=annualizeRow(x); const v=Math.max(a.net_A,a.net_B); if(!Number.isFinite(v))continue;
    hrs++; if(v>0){ sum+=v; let i=B.findIndex(b=>v<=b); if(i<0)i=B.length-1; contrib[i]+=v; cnt[i]++; } } }
console.log("## Распределение ЛУЧШЕЙ часовой годовой ставки max(net_A,net_B) по 63 именам x 8761 ч");
console.log(`  всего часов ${hrs.toLocaleString()}, положительных вкладов ${cnt.reduce((a,b)=>a+b,0).toLocaleString()}`);
console.log("| годовая ставка часа | часов | доля часов | доля всей положительной суммы |");
console.log("|---|---|---|---|");
B.forEach((_,i)=>console.log(`| ${lbl[i]} | ${cnt[i].toLocaleString()} | ${(100*cnt[i]/hrs).toFixed(3)}% | ${(100*contrib[i]/sum).toFixed(1)}% |`));
console.log(`\n  ставка 1e6% годовых = ${(1e4/8760*100).toFixed(0)}% ноционала В ЧАС.`);
console.log("  GMX V2 ограничивает maxFundingFactorPerSecond; наблюдаемый максимум по кэшу:");
let mx=0,mt=null,mi=0;
for(const t of toks){const r=all.get(t); if(!r)continue; r.forEach((x,i)=>{const v=x.f_short*3600*8760; if(v>mx){mx=v;mt=t;mi=i;}});}
console.log(`    f_short годовой максимум ${(100*mx).toFixed(0)}% у ${mt} в часе ${mi}`);
console.log(`    это ${(mx/31536000).toExponential(2)} за секунду (типовой протокольный потолок ~1e-8..1e-7/с)`);
const above=[];
for(const t of toks){const r=all.get(t); if(!r)continue; let c=0; r.forEach(x=>{const v=Math.max(...[x.f_short,x.f_long].map(y=>y*3600*8760)); if(v>100)c++;});
  if(c) above.push([t,c]);}
above.sort((a,b)=>b[1]-a[1]);
console.log(`\n  имён с хотя бы одним часом выше 10000% годовых по f_*: ${above.length} из ${toks.length}`);
console.log(`  топ: ${above.slice(0,12).map(([t,c])=>`${t}(${c} ч)`).join(", ")}`);
console.log("\n## Ёмкость контрагента: можно ли ВООБЩЕ получить столько финансирования");
for (const [t,i0,i1] of [["LDO",5040,5760],["S",2160,2880],["TIA",7920,8640]]) {
  const r=all.get(t).slice(i0,i1); const c=CAP.get(t);
  const recv=r.reduce((a,x)=>a+x.f_short*3600,0);          // доля ноционала за окно
  console.log(`  ${t}: за окно шорт получает ${(100*recv).toFixed(0)}% ноционала; снимок ОИ 30.08.2026 oiLong ${f(c.oiLong)}, oiShort ${f(c.oiShort)}, своб. ликв. short ${f(c.availShort)}`);
  console.log(`     то есть на позиции ${f(c.availShort/10)} модель начисляет ${f(c.availShort/10*recv)} финансирования, а ВСЯ противоположная сторона рынка в снимке ${f(c.oiLong)}`);
}
