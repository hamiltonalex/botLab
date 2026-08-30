// 4. Не прячется ли ответ в ДЫРАХ ДАННЫХ: до какого размера кривая impact GMX вообще ИЗМЕРЕНА,
//    и как далеко за край её экстраполируют выбранные позиции. interpLog() за краем держит
//    ПОЛКУ (крайний узел), значит вне измеренного диапазона impact по построению не растёт.
import { TAB, PER, GMXI, HLI, CAP, YRS, costRound, gmxRtBps } from "./run4-lib.mjs";
import { caps } from "./run4-grid.mjs";
const f=(x)=>(x<0?"-$":"$")+Math.round(Math.abs(x)).toLocaleString("en-US");
const P=(o,k)=>o?o[k]:undefined;

// восстановим тот же набор порыночных кривых, что строит run4-lib
const mkt=new Map();
for (const [t,g] of Object.entries(GMXI.growth.byMarket||{})) for(const side of ["short","long"]){
  const bands=P(g[`postClose_${side}`],"bands")||[];
  const nodes=bands.filter(b=>b.n>=25&&Number.isFinite(b.medBps)).map(b=>({x:b.medSizeUsd,y:b.medBps,n:b.n}));
  if(nodes.length>=3) mkt.set(`${t}|${side}`,nodes);
}
console.log(`## порыночных кривых GMX: ${mkt.size}`);
const maxes=[...mkt].map(([k,n])=>({k,max:n[n.length-1].x,min:n[0].x,n:n.length}));
maxes.sort((a,b)=>a.max-b.max);
const q=(a,p)=>a[Math.floor(p*(a.length-1))].max;
console.log(`  верхний ИЗМЕРЕННЫЙ узел кривой: мин ${f(maxes[0].max)}, 25-й проц. ${f(q(maxes,0.25))}, медиана ${f(q(maxes,0.5))}, 75-й ${f(q(maxes,0.75))}, макс ${f(maxes[maxes.length-1].max)}`);
console.log(`  объединённая кривая: верхний узел short ${f(GMXI.curveForModel.short_roundTripCurrentRegime.slice(-1)[0].sizeUsd)}, long ${f(GMXI.curveForModel.long_roundTripCurrentRegime.slice(-1)[0].sizeUsd)}`);

// какие размеры реально ставит бот и насколько это за краем измерений
function led({capital,N=3,K=8,sane=10,margin=1,hlVariant="correctedSqrt",gmxAdverse=false,sizer}){
  const out=[]; let held=new Map();
  for(let pi=0;pi<TAB.length;pi++){ const hrs=PER[pi][1]-PER[pi][0];
    const cand=[...TAB[pi].entries()].filter(([,d])=>Number.isFinite(d.peak)&&d.peak<=sane).map(([t,d])=>({t,...d})).sort((a,b)=>b.v-a.v);
    let left=capital; const now=new Map();
    for(const s of cand){ if(now.size>=K||left<=1)break;
      const o={hlVariant,gmxAdverse,margin,hlTrail:s.hlTrail};
      const hi=Math.min(caps(s.t,s.cfg,o),capital/N,left); if(!(hi>10))continue;
      const gEst=sizer==="causal"?s.v*hrs/8760:s.g1;
      let best=0,bv=-Infinity;
      for(let k=0;k<=400;k++){const S=10*Math.pow(hi/10,k/400); if(S>hi)break;
        const v=gEst*S-costRound(s.t,s.cfg,S,o).total; if(v>bv){bv=v;best=S;}}
      if(!(bv>0))continue;
      const prev=held.get(s.t+s.cfg);
      const c=(prev&&Math.abs(prev-best)/best<1e-9)?0:costRound(s.t,s.cfg,best,o).total;
      out.push({pi,t:s.t,cfg:s.cfg,size:best,net:s.g1*best-c});
      now.set(s.t+s.cfg,best); left-=best; }
    held=now; }
  return out;
}
for (const [lbl,cfg] of [["БАЗА $1M (размер прогона)",{capital:1e6,sizer:"lookahead"}],
                          ["БАЗА $10M (размер прогона)",{capital:1e7,sizer:"lookahead"}]]) {
  const L=led(cfg); let over=0, ovNet=0, tot=0, noCurve=0, ncNet=0;
  const ratios=[];
  for(const r of L){ tot+=r.net;
    const key=`${r.t}|${r.cfg==="A"?"short":"long"}`; const n=mkt.get(key);
    if(!n){noCurve++; ncNet+=r.net; continue;}
    const top=n[n.length-1].x; ratios.push(r.size/top);
    if(r.size>top){over++; ovNet+=r.net;} }
  ratios.sort((a,b)=>a-b);
  console.log(`\n## ${lbl}: ${L.length} позиций, чистый ${f(tot/YRS)}/год`);
  console.log(`  без своей кривой (объединённая): ${noCurve} позиций, ${(100*ncNet/tot).toFixed(0)}% чистого`);
  console.log(`  размер ВЫШЕ верхнего измеренного узла своей кривой: ${over} позиций (${(100*over/L.length).toFixed(0)}%), ${(100*ovNet/tot).toFixed(0)}% чистого`);
  console.log(`  отношение размер/верхний узел: медиана ${ratios.length?ratios[Math.floor(ratios.length/2)].toFixed(1):"-"}x, 90-й проц. ${ratios.length?ratios[Math.floor(0.9*(ratios.length-1))].toFixed(1):"-"}x, макс ${ratios.length?ratios[ratios.length-1].toFixed(1):"-"}x`);
}
console.log("\n## Что даёт полка: impact GMX в бп при росте размера (медиана по кривым)");
const sizes=[1e4,1e5,1e6,1e7];
for (const t of ["S","TIA","LDO","ONDO","DYDX"]) {
  const row=sizes.map(S=>gmxRtBps(t,"A",S).toFixed(2)+"/"+gmxRtBps(t,"B",S).toFixed(2));
  const kA=mkt.get(`${t}|short`), kB=mkt.get(`${t}|long`);
  console.log(`  ${t}: A/B бп при ${sizes.map(f).join(", ")} = ${row.join(" | ")}; верхний измеренный узел A ${kA?f(kA[kA.length-1].x):"нет кривой"}, B ${kB?f(kB[kB.length-1].x):"нет кривой"}`);
}
console.log("\n## Стакан HL: до какого размера он ВИДЕН и куда экстраполируют");
const xs=HLI.meta.xs; console.log(`  узлы стакана: ${xs.map(f).join(", ")}`);
const vis=[...CAP.keys()].map(t=>{const d=HLI.tokens[t]?.correctedSqrt; return d? Math.min(d.buy.visibleNtl,d.sell.visibleNtl):NaN;}).filter(Number.isFinite).sort((a,b)=>a-b);
console.log(`  видимый стакан (мин по сторонам): медиана ${f(vis[Math.floor(vis.length/2)])}, 10-й проц ${f(vis[Math.floor(0.1*vis.length)])}, макс ${f(vis[vis.length-1])}, n=${vis.length}`);
