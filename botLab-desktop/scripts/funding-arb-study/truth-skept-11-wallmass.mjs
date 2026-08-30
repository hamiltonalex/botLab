import { TOKS, marketHours } from "./truth-skept-9-core.mjs";
const YR=3600*8760;
console.log("МАССА У СТЕНЫ: сколько часов ставка ПЛАТЕЛЬЩИКА стоит ровно на своём годовом максимуме");
console.log("тк        стена %год    часов ровно на стене  часов в пределах 0.1%  всего часов   стена=круглый %?");
let tot=0,totWall=0;
const rows=[];
for(const t of TOKS){
  const M=marketHours(t); if(!M) continue;
  const p=[];
  for(const r of M){
    const al=Math.abs(r.fl),as=Math.abs(r.fs);
    if(!(al>0&&as>0&&r.bl>0&&r.bs>0)) continue;
    p.push(r.bl>r.bs?al:as);
  }
  if(!p.length) continue;
  const w=Math.max(...p);
  const exact=p.filter(x=>x===w).length;
  const near=p.filter(x=>x>=w*0.999).length;
  const ann=w*YR*100;
  const round=Math.abs(ann-Math.round(ann*10)/10)<0.005 && Math.abs(ann-Math.round(ann))<0.02;
  rows.push({t,ann,exact,near,n:p.length,round});
  tot+=p.length; totWall+=near;
}
rows.sort((a,b)=>b.near-a.near);
for(const r of rows.slice(0,20)) console.log(r.t.padEnd(9),r.ann.toFixed(3).padStart(10),String(r.exact).padStart(20),String(r.near).padStart(22),String(r.n).padStart(12),"   "+(r.round?"ДА":"нет"));
console.log("...");
console.log("рынков со стеной = круглый процент годовых:", rows.filter(r=>r.round).length, "из", rows.length);
console.log("часов в пределах 0.1% от своей стены:", totWall, "из", tot, (100*totWall/tot).toFixed(2)+"%");
console.log("\nрынки БЕЗ массы у стены (near<=3) - стена там может быть выбросом, а не потолком:");
console.log(rows.filter(r=>r.near<=3).map(r=>r.t+"("+r.ann.toFixed(1)+"%,"+r.near+")").join(" "));
