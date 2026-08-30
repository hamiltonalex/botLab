import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const U=JSON.parse(fs.readFileSync("hlc-skept-univ.json","utf8"));
const g={cache:[],liveOut:[],dead:[]};
for(const [t,o] of Object.entries(U)){
  const r=o.rows.filter(x=>Number.isFinite(x[1])); if(r.length<400) continue;
  if(r.filter(x=>x[1]!==0).length<r.length*0.5) continue;
  const apr=r.reduce((s,x)=>s+x[1],0)/r.length*8760;
  (o.inCache?g.cache:o.delisted?g.dead:g.liveOut).push({t,apr});
}
const m=(a)=>L.q(a.map(x=>x.apr),0.5), mn=(a)=>L.mean(a.map(x=>x.apr));
const all=[...g.cache,...g.liveOut,...g.dead];
for(const [k,a] of [["кэш (93)",g.cache],["живые HL вне кэша",g.liveOut],["делистнутые живые",g.dead],["ВСЯ вселенная",all]])
  console.log(`${k.padEnd(20)} n=${String(a.length).padStart(3)}  медиана ${L.pc(m(a)).padStart(9)}  среднее ${L.pc(mn(a)).padStart(9)}  плюсовых ${a.filter(x=>x.apr>0).length}/${a.length}`);
console.log("смещение кэша против вселенной:", L.pc(m(g.cache)-m(all)));
