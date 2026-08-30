import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const U=JSON.parse(fs.readFileSync("hlc-skept-univ.json","utf8"));
const grp={cache:[],liveOut:[],dead:[]};
for(const [t,o] of Object.entries(U)){
  const r=o.rows.filter(x=>Number.isFinite(x[1]));
  if(r.length<400) continue;                       // нужен внятный охват выборочных окон
  const apr=r.reduce((s,x)=>s+x[1],0)/r.length*8760;
  const rec={t,n:r.length,apr};
  if(o.inCache) grp.cache.push(rec); else if(o.delisted) grp.dead.push(rec); else grp.liveOut.push(rec);
}
const m=(a)=>L.q(a.map(x=>x.apr),0.5);
console.log(`ОТБОР: выборочные окна 4x500ч по всей вселенной HL (шорт-керри, %/год)`);
console.log(`  93 монеты кэша:            n=${grp.cache.length}  медиана ${L.pc(m(grp.cache))}  плюсовых ${grp.cache.filter(x=>x.apr>0).length}  среднее ${L.pc(L.mean(grp.cache.map(x=>x.apr)))}`);
console.log(`  живые HL ВНЕ кэша:         n=${grp.liveOut.length}  медиана ${L.pc(m(grp.liveOut))}  плюсовых ${grp.liveOut.filter(x=>x.apr>0).length}  среднее ${L.pc(L.mean(grp.liveOut.map(x=>x.apr)))}`);
console.log(`  ДЕЛИСТНУТЫЕ (торговались): n=${grp.dead.length}  медиана ${L.pc(m(grp.dead))}  плюсовых ${grp.dead.filter(x=>x.apr>0).length}  среднее ${L.pc(L.mean(grp.dead.map(x=>x.apr)))}`);
const allx=[...grp.cache,...grp.liveOut,...grp.dead];
console.log(`  ВСЯ вселенная:             n=${allx.length}  медиана ${L.pc(m(allx))}  плюсовых ${allx.filter(x=>x.apr>0).length}  среднее ${L.pc(L.mean(allx.map(x=>x.apr)))}`);
const w=(a)=>{const s=[...a].sort((x,y)=>x.apr-y.apr); return s.slice(0,6).map(x=>`${x.t} ${L.pc(x.apr,0)}`).join(", ");};
console.log(`\n  худшие в кэше:      ${w(grp.cache)}`);
console.log(`  худшие вне кэша:    ${w(grp.liveOut)}`);
console.log(`  худшие делистнутые: ${w(grp.dead)}`);
// смещение: сравнение на ОДНИХ И ТЕХ ЖЕ выборочных часах
console.log(`\nсмещение отбора кэша = медиана(кэш) - медиана(вся вселенная) = ${L.pc(m(grp.cache)-m(allx))}`);
console.log(`доля вселенной, попавшая в кэш: ${grp.cache.length}/${allx.length} = ${(100*grp.cache.length/allx.length).toFixed(0)}%`);
