// 7. Итоговый стек честности и на чём держится решающая клетка прогона.
import { TAB, PER, YRS, costRound, CAP, HLI } from "./run4-lib.mjs";
import { caps } from "./run4-grid.mjs";
const f=(x)=>(x<0?"-$":"$")+Math.round(Math.abs(x)).toLocaleString("en-US");
function sim({capital,N=3,K=8,sane=10,margin=1,hlVariant="correctedSqrt",gmxAdverse=false,causal=true}){
  const led=[]; let held=new Map();
  for(let pi=0;pi<TAB.length;pi++){ const hrs=PER[pi][1]-PER[pi][0];
    const cand=[...TAB[pi].entries()].filter(([,d])=>Number.isFinite(d.peak)&&d.peak<=sane).map(([t,d])=>({t,...d})).sort((a,b)=>b.v-a.v);
    let left=capital; const now=new Map();
    for(const s of cand){ if(now.size>=K||left<=1)break;
      const o={hlVariant,gmxAdverse,margin,hlTrail:s.hlTrail};
      const hi=Math.min(caps(s.t,s.cfg,o),capital/N,left); if(!(hi>10))continue;
      const g=causal?s.v*hrs/8760:s.g1;
      let best=0,bv=-Infinity;
      for(let k=0;k<=400;k++){const S=10*Math.pow(hi/10,k/400); if(S>hi)break;
        const v=g*S-costRound(s.t,s.cfg,S,o).total; if(v>bv){bv=v;best=S;}}
      if(!(bv>0))continue;
      const prev=held.get(s.t+s.cfg);
      const c=(prev&&Math.abs(prev-best)/best<1e-9)?0:costRound(s.t,s.cfg,best,o).total;
      led.push({pi,t:s.t,cfg:s.cfg,size:best,gross:s.g1*best,cost:c,net:s.g1*best-c,realAPR:s.g1*8760/hrs,trainV:s.v,peak:s.peak,hrs});
      now.set(s.t+s.cfg,best); left-=best; }
    held=now; }
  return led;
}
const W=PER.map(([a,b])=>(b-a)/8760);
function boot(led,filter=()=>true){
  const per=Array.from({length:TAB.length},(_,i)=>led.filter(r=>r.pi===i&&filter(r)).reduce((a,x)=>a+x.net,0));
  let s=7; const rnd=()=>{s=(s*1103515245+12345)&0x7fffffff;return s/0x7fffffff;};
  const out=[];
  for(let b=0;b<20000;b++){let n=0,w=0;for(let k=0;k<per.length;k++){const j=Math.floor(rnd()*per.length);n+=per[j];w+=W[j];}out.push(n/w);}
  out.sort((a,b)=>a-b);
  return {p50:out[10000],p5:out[1000],p95:out[19000],below:out.filter(x=>x<25000).length/out.length,
          tot:per.reduce((a,x)=>a+x,0)/YRS};
}
const TIGHT={margin:10,hlVariant:"raw",gmxAdverse:true,sane:5};
const CONS={margin:5,hlVariant:"raw",gmxAdverse:true,sane:5};
console.log("## 7.1 Стек: что остаётся от ответа при снятии заглядывания и отсечении вырожденных ставок");
console.log("| угол | капитал | как в прогоне | + причинный размер | + отсечение реализ.>1000% | 90% ИД причинного | P(<$25k) |");
console.log("|---|---|---|---|---|---|---|");
for (const [lbl,o,cs] of [["БАЗА",{},[1e6]],["КОНСЕРВ 20%",CONS,[3e5,1e6,1e7]],["ПРЕДЕЛЬНО 10%",TIGHT,[1e5,1e6,1e7]]])
 for (const c of cs) {
  const a=sim({capital:c,causal:false,...o}), b=sim({capital:c,causal:true,...o});
  const B=boot(b), Bd=boot(b,r=>r.realAPR<=10);
  console.log(`| ${lbl} | ${f(c)} | ${f(a.reduce((x,y)=>x+y.net,0)/YRS)} | ${f(B.tot)} | ${f(Bd.tot)} | [${f(B.p5)} .. ${f(B.p95)}] | ${(100*B.below).toFixed(0)}% |`);
 }

console.log("\n## 7.2 Решающая клетка прогона: ПРЕДЕЛЬНО + отсечение >1000% (прогон: $24.3k на плато)");
for (const c of [1e5,3e5,1e6,3e6,1e7]) {
  const a=sim({capital:c,causal:false,...TIGHT}), b=sim({capital:c,causal:true,...TIGHT});
  const A=a.filter(r=>r.realAPR<=10).reduce((x,y)=>x+y.net,0)/YRS;
  const Bv=b.filter(r=>r.realAPR<=10).reduce((x,y)=>x+y.net,0)/YRS;
  console.log(`  ${f(c)}: как в прогоне ${f(A)}/год, причинный размер ${f(Bv)}/год`);
}

console.log("\n## 7.3 На чём держится ПРЕДЕЛЬНО-угол: разбор главного имени");
const led=sim({capital:1e6,causal:true,...TIGHT});
const byT=new Map(); for(const r of led) byT.set(r.t,(byT.get(r.t)||0)+r.net);
const top=[...byT].sort((a,b)=>b[1]-a[1])[0];
const tot=led.reduce((a,b)=>a+b.net,0);
console.log(`  главное имя ${top[0]}: ${f(top[1]/YRS)}/год = ${(100*top[1]/tot).toFixed(0)}% всего`);
for (const r of led.filter(r=>r.t===top[0]))
  console.log(`    п.${r.pi+1} (${r.hrs} ч) ${r.cfg}: размер ${f(r.size)}, вал ${f(r.gross)}, издержка ${f(r.cost)}, чистый ${f(r.net)}, реализовано ${(100*r.realAPR).toFixed(0)}% годовых, обучающая оценка ${(100*r.trainV).toFixed(0)}%`);
const cp=CAP.get(top[0]);
console.log(`  снимок ёмкости 30.08.2026: availLong ${f(cp.availLong)}, availShort ${f(cp.availShort)}, oiLong ${f(cp.oiLong)}, oiShort ${f(cp.oiShort)}, листинг ${cp.listing||"-"}`);
const hb=HLI.tokens[top[0]]?.raw;
console.log(`  видимый стакан HL (сырой): buy ${f(hb.buy.visibleNtl)}, sell ${f(hb.sell.visibleNtl)}`);
console.log(`  один месяц из десяти даёт ${(100*Math.max(...Array.from({length:10},(_,i)=>led.filter(r=>r.pi===i).reduce((a,b)=>a+b.net,0)))/tot).toFixed(0)}% всего итога`);

console.log("\n## 7.4 Сколько имён нужно выбросить, чтобы ответ ушёл ниже порога (ПРЕДЕЛЬНО, причинный)");
const srt=[...byT].sort((a,b)=>b[1]-a[1]);
let acc=tot; const drop=[];
for (const [t,v] of srt){ drop.push(t); acc-=v; console.log(`  убрано ${drop.length} имён (${drop.join(",")}): остаётся ${f(acc/YRS)}/год`); if(drop.length>=4) break; }
