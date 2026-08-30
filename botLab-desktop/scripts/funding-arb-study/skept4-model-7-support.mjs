// А1. Есть ли под выбранными позициями наблюдения НУЖНОГО размера, или кривая экстраполирована в пустоту.
import { run } from "./skept4-model-5-grid.mjs";
import { makeCost, bandsOf, topNode, CAP } from "./skept4-model-5-lib.mjs";
const f=x=>"$"+Math.round(x).toLocaleString("en-US");
const cf=makeCost("total");
for(const capital of [100000,1000000,10000000]){
  const dump=[]; run({capital,cf,dump});
  const uniq=new Map();
  let beyond=0, nAtNode=[], noOwn=0;
  for(const p of dump){
    const bands=bandsOf(p.t,p.cfg);
    const own=bands.filter(b=>b.n>=25); if(own.length<3)noOwn++;
    const top=topNode(p.t,p.cfg,"total");
    if(top&&p.size>top.x)beyond++;
    // сколько наблюдений в полосе, куда попадает наш размер
    const E=[0,1e3,5e3,20e3,50e3,200e3,500e3,1e6,2e6,5e6,Infinity];
    const L=["<$1k","$1-5k","$5-20k","$20-50k","$50-200k","$200-500k","$500k-1M","$1-2M","$2-5M",">=$5M"];
    let bi=0; for(let i=E.length-2;i>=0;i--) if(p.size>=E[i]){bi=i;break;}
    const hit=bands.find(b=>b.band===L[bi]);
    nAtNode.push(hit?hit.n:0);
    const k=p.t+p.cfg; const cur=uniq.get(k)||{n:0,max:0,sizes:[]}; cur.n++; cur.max=Math.max(cur.max,p.size); cur.sizes.push(p.size); uniq.set(k,cur);
  }
  const srt=nAtNode.slice().sort((a,b)=>a-b);
  const q=p=>srt[Math.floor((srt.length-1)*p)];
  console.log(`\n## капитал ${f(capital)}: позиций ${dump.length}, уникальных имя+конфиг ${uniq.size}`);
  console.log(`  без собственной кривой рынка (падаем на общий пул): ${noOwn} (${(100*noOwn/dump.length).toFixed(0)}%)`);
  console.log(`  размер ЗА последним узлом собственной кривой (держим полку): ${beyond} (${(100*beyond/dump.length).toFixed(0)}%)`);
  console.log(`  наблюдений в полосе своего размера у своего рынка: p10=${q(.1)} p25=${q(.25)} мед=${q(.5)} p75=${q(.75)} | ровно 0 у ${srt.filter(x=>x===0).length} позиций (${(100*srt.filter(x=>x===0).length/srt.length).toFixed(0)}%)`);
  const sizes=dump.map(p=>p.size).sort((a,b)=>a-b);
  console.log(`  размеры позиций: p10 ${f(sizes[Math.floor(sizes.length*.1)])} мед ${f(sizes[Math.floor(sizes.length*.5)])} p90 ${f(sizes[Math.floor(sizes.length*.9)])} макс ${f(sizes[sizes.length-1])}`);
  if(capital===1000000){
    console.log("  10 крупнейших позиций и опора кривой под ними:");
    for(const p of dump.slice().sort((a,b)=>b.size-a.size).slice(0,10)){
      const bands=bandsOf(p.t,p.cfg); const top=topNode(p.t,p.cfg,"total");
      console.log(`    ${p.t}/${p.cfg} ${f(p.size)} | полос своих ${bands.length} | верхний узел ${top?f(top.x)+" (n="+top.n+")":"нет"} | ${top&&p.size>top.x?"ЭКСТРАПОЛЯЦИЯ полкой":"внутри"}`);
    }
  }
}
