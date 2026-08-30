import {loadY1,loadY2,walkCal,pc,stats,MAJORS} from "./skept-y2-03-lib.mjs";
const y1=loadY1(),y2=loadY2();
const uni10=["BTC","ETH","SOL","BNB","XRP","DOGE","LINK","LTC","ARB","UNI"];
const cut=new Map(uni10.map(t=>[t,y2.get(t).slice(-12000)]));
const A=walkCal({rowsBy:cut,tokens:uni10,W:90,H:30,N:3}),sA=stats(A.byPeriod,A.perLen);
// без хвостового огрызка (481 ч)
const s2=stats(A.byPeriod.slice(0,13),A.perLen.slice(0,13));
console.log(`# период2 без хвостового окна в 481 ч: n=${s2.n} средн ${pc(s2.mean)} sd ${pc(s2.sd)} t=${s2.t.toFixed(2)} CI [${pc(s2.ci[0])}, ${pc(s2.ci[1])}]`);
const h1=sA.series.slice(0,9),h2=sA.series.slice(9);
const m=a=>a.reduce((s,v)=>s+v,0)/a.length;
console.log(`# дрейф внутри периода 2: первые 9 окон (05.2024-01.2025) ${pc(m(h1))}, последние 5 (02-06.2025) ${pc(m(h2))}`);

// «полная вселенная» периода 1: правда ли 23 мажора = вся вселенная
const all93=[...y1.keys()].filter(t=>y1.get(t).length===8761);
console.log(`\n# «полная вселенная» периода 1: файлов с полным годом ${all93.length} (мажоров ${MAJORS.filter(t=>y1.get(t)?.length===8761).length})`);
for(const [n,tok] of [["23 мажора",MAJORS.filter(t=>y1.get(t)?.length===8761)],[`${all93.length} имён (весь кэш)`,all93]]){
  const r=walkCal({rowsBy:y1,tokens:tok,W:90,H:30,N:3});const s=stats(r.byPeriod,r.perLen);
  console.log(`  ${n.padEnd(22)} APR ${pc(r.apr).padStart(8)} | ${r.pos}/${r.periods} | t=${s.t.toFixed(2)}`);
}
