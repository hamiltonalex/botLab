import {loadY1,loadY2,walkCal,pc,stats,MAJORS} from "./skept-y2-03-lib.mjs";
const y1=loadY1(),y2=loadY2();
const uni10=["BTC","ETH","SOL","BNB","XRP","DOGE","LINK","LTC","ARB","UNI"];
const full23=MAJORS.filter(t=>y1.get(t)?.length===8761);
const cut=new Map(uni10.map(t=>[t,y2.get(t).slice(-12000)]));

const A=walkCal({rowsBy:cut,tokens:uni10,W:90,H:30,N:3}), sA=stats(A.byPeriod,A.perLen);
const B=walkCal({rowsBy:y1,tokens:uni10,W:90,H:30,N:3}), sB=stats(B.byPeriod,B.perLen);

console.log("# ДАТЫ ПОПЕРИОДНЫХ ГОДОВЫХ, период 2 (10 имён, W90 H30 N3)");
{let ts=Date.parse("2024-05-06T06:00:00Z")/1000;
 sA.series.forEach((v,i)=>{const a=new Date(ts*1000).toISOString().slice(0,10);ts+=A.perLen[i]*3600;console.log(`  ${a} .. ${new Date(ts*1000).toISOString().slice(0,10)}  ${(100*v).toFixed(1).padStart(7)}%  (${A.perLen[i]} ч)`);});}

const welch=(x,y)=>{const m=a=>a.reduce((s,v)=>s+v,0)/a.length,
 v=a=>{const mm=m(a);return a.reduce((s,q)=>s+(q-mm)**2,0)/(a.length-1);};
 const d=m(x)-m(y), se=Math.sqrt(v(x)/x.length+v(y)/y.length);
 const df=(v(x)/x.length+v(y)/y.length)**2/((v(x)/x.length)**2/(x.length-1)+(v(y)/y.length)**2/(y.length-1));
 return {d,se,t:d/se,df};};
const w=welch(sA.series,sB.series);
console.log(`\n# РАЗЛИЧИМА ЛИ РАЗНИЦА +7.35% против +3.95%`);
console.log(`  период2: n=${sA.n} средн ${pc(sA.mean)} sd ${pc(sA.sd)} t=${sA.t.toFixed(2)} CI [${pc(sA.ci[0])}, ${pc(sA.ci[1])}]`);
console.log(`  период1: n=${sB.n} средн ${pc(sB.mean)} sd ${pc(sB.sd)} t=${sB.t.toFixed(2)} CI [${pc(sB.ci[0])}, ${pc(sB.ci[1])}]`);
console.log(`  разница ${pc(w.d)} +- ${pc(w.se)}, Welch t=${w.t.toFixed(2)} df=${w.df.toFixed(1)} -> НЕразличима (|t|<2)`);
console.log(`  ЗНАК разницы: период 2 ${w.d>0?"ВЫШЕ":"НИЖЕ"} периода 1`);
// перестановочный тест: объединить ряды, случайно переразбить
{let s=987654321;const rnd=()=>((s=(s*1103515245+12345)&0x7fffffff)/0x7fffffff);
 const pool=[...sA.series,...sB.series];let ge=0,B2=50000;
 for(let b=0;b<B2;b++){const p=pool.slice();for(let i=p.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[p[i],p[j]]=[p[j],p[i]];}
  const x=p.slice(0,sA.n),y=p.slice(sA.n);const mm=a=>a.reduce((q,v)=>q+v,0)/a.length;
  if(Math.abs(mm(x)-mm(y))>=Math.abs(w.d))ge++;}
 console.log(`  перестановочный p (двусторонний) = ${(ge/B2).toFixed(3)}`);}

console.log(`\n# ЧУВСТВИТЕЛЬНОСТЬ К ПОРОГУ ИСТОРИИ (та же ячейка W90 H30 N3, период 2)`);
for(const mr of [15000,12000,10000,8760,6000]){
  const uni=MAJORS.filter(t=>y2.get(t)?.length>=mr);
  if(uni.length<4){console.log(`  ${mr}: имён ${uni.length}, мало`);continue;}
  const m=new Map(uni.map(t=>[t,y2.get(t).slice(-mr)]));
  const r=walkCal({rowsBy:m,tokens:uni,W:90,H:30,N:3}); const s=stats(r.byPeriod,r.perLen);
  console.log(`  порог ${String(mr).padStart(5)} ч, имён ${String(uni.length).padStart(2)}: APR ${pc(r.apr).padStart(8)} | ${r.pos}/${r.periods} | t=${s.t.toFixed(2)} CI [${pc(s.ci[0])}, ${pc(s.ci[1])}]`);
}

console.log(`\n# ЧТО НА САМОМ ДЕЛЕ ДАЁТ +29.78%: период 1, 23 имени, минус крупнейшие`);
for(const drop of [[],["FIL"],["FIL","OP"],["FIL","OP","TRX"]]){
  const tok=full23.filter(t=>!drop.includes(t));
  const r=walkCal({rowsBy:y1,tokens:tok,W:90,H:30,N:3}); const s=stats(r.byPeriod,r.perLen);
  console.log(`  без [${drop.join(",")||"-"}] (${tok.length} имён): APR ${pc(r.apr).padStart(8)} | ${r.pos}/${r.periods} | t=${s.t.toFixed(2)}`);
}
console.log(`\n# ЛИСТИНГ имён-вкладчиков в GMX (когда появились в кэше периода 2)`);
for(const t of ["FIL","OP","TRX","XLM","DOT","ADA","BCH"])
  console.log(`  ${t.padEnd(5)} y2 строк ${String(y2.get(t)?.length||0).padStart(6)}  с ${y2.get(t)?y2.get(t)[0].ts.slice(0,10):"-"}`);

console.log(`\n# БАЗА БЕЗ ОТБОРА: равный вес всех 10 имён, период 2 и период 1`);
for(const [n,rb,tk] of [["период2",cut,uni10],["период1",y1,uni10]]){
  const r=walkCal({rowsBy:rb,tokens:tk,W:90,H:30,N:10}); const s=stats(r.byPeriod,r.perLen);
  console.log(`  ${n}: APR ${pc(r.apr).padStart(8)} | ${r.pos}/${r.periods} | t=${s.t.toFixed(2)}`);
}
