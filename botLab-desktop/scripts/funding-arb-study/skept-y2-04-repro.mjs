import {loadY1,loadY2,walkCal,pc,stats,MAJORS} from "./skept-y2-03-lib.mjs";
const y1=loadY1(),y2=loadY2();
const Y=8761;
const uni10=["BTC","ETH","SOL","BNB","XRP","DOGE","LINK","LTC","ARB","UNI"];
const full23=MAJORS.filter(t=>y1.get(t)?.length===Y);
console.log(`# базы: y1 файлов ${y1.size}, полных мажоров ${full23.length}: ${full23.join(",")}`);

// период 2, вселенная 10, отрезано по КАЛЕНДАРЮ последними 12000 ч (как у автора slice(-12000))
const cut=new Map(uni10.map(t=>[t,y2.get(t).slice(-12000)]));
console.log(`\n# ВОСПРОИЗВЕДЕНИЕ (календарное выравнивание, своя реализация)`);
const rows=[];
for(const [name,rowsBy,tok] of [["период2 10имён",cut,uni10],["период1 10имён",y1,uni10],["период1 23имени",y1,full23]]){
  for(const [W,H,N] of [[90,30,3],[90,30,1]]){
    const r=walkCal({rowsBy,tokens:tok,W,H,N,key:"median"});
    const s=stats(r.byPeriod,r.perLen);
    rows.push({name,W,H,N,r,s});
    console.log(`${name.padEnd(16)} W${W} H${H} N${N} | ${r.from}..${r.to} | APR ${pc(r.apr).padStart(8)} | периодов ${r.periods} плюс ${r.pos} | брутто ${r.gross.toFixed(2)} нетто ${r.net.toFixed(2)} входов ${r.opens} | средн.год ${pc(s.mean)} sd ${pc(s.sd)} t=${s.t.toFixed(2)} 95%CI [${pc(s.ci[0])}, ${pc(s.ci[1])}]`);
  }
}
console.log(`\n# РЯД ПОПЕРИОДНЫХ ГОДОВЫХ (W90 H30 N3)`);
for(const q of rows.filter(x=>x.N===3)) console.log(`${q.name.padEnd(16)} [${q.s.series.map(v=>(100*v).toFixed(1)).join(", ")}]`);

console.log(`\n# ВКЛАД ИМЁН на периоде 1 (23 имени, W90 H30 N3): что даёт +29.78%`);
const b=rows.find(x=>x.name==="период1 23имени"&&x.N===3).r;
const tt=[...b.byToken.entries()].sort((a,c)=>c[1]-a[1]);
tt.forEach(([t,g])=>console.log(`  ${t.padEnd(6)} ${g.toFixed(2).padStart(9)}  ${uni10.includes(t)?"в десятке":""}`));
const inTen=tt.filter(([t])=>uni10.includes(t)).reduce((s,[,g])=>s+g,0);
console.log(`  брутто от 10 «общих» имён: ${inTen.toFixed(2)} из ${b.gross.toFixed(2)} (${(100*inTen/b.gross).toFixed(1)}%)`);
