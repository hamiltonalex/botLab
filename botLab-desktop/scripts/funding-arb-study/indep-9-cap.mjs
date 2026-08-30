import fs from "node:fs"; import { SP } from "./indep-lib.mjs";
const {SIZES,out}=JSON.parse(fs.readFileSync(`${SP}/indep-fine.json`,"utf8"));
const cap=JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8"));
const capBy=new Map(cap.map(c=>[c.t,c]));
const $=(x)=>(x<0?"-":"")+"$"+Math.abs(x).toFixed(0);
console.log("=== места на GMX для крупных рынков (снимок) ===");
for(const t of ["ETH","BTC","LINK","SOL","XRP","DOGE","BERA","ANIME","APT","SEI","PENGU","FET","CRV"]){
  const c=capBy.get(t); if(!c)continue;
  console.log(`${t.padEnd(8)} availShort ${$(c.availShort).padStart(12)}  availLong ${$(c.availLong).padStart(12)}  hlOi ${$(c.hlOi).padStart(13)}`);
}
console.log("\n=== C-детали: pot/gmx-нога, оптимальный размер на рынок ===");
const rows=[];
for(const t of Object.keys(out)){
  let b=null;
  for(const S of SIZES)for(const c of ["A","B"]){const r=out[t].rows[S],d=r.cells[c+"pot"];
    const v=d.f+d.b-r.rt; if(!b||v>b.v)b={S,c,v};}
  if(b.v>0)rows.push({t,...b, avail: capBy.get(t)? (b.c==="A"?capBy.get(t).availShort:capBy.get(t).availLong):NaN});
}
rows.sort((a,b)=>b.v-a.v);
for(const r of rows.slice(0,15))
  console.log(`${r.t.padEnd(9)}${r.c} S*=${$(r.S).padStart(10)} доход ${$(r.v).padStart(10)}  место на GMX сейчас ${$(r.avail).padStart(11)}`);
console.log("сумма топ-15:", $(rows.slice(0,15).reduce((a,r)=>a+r.v,0)), " всего:", $(rows.reduce((a,r)=>a+r.v,0)));
// с ограничением по свободному месту (снимок)
let capped=0,capital=0,n=0;
for(const t of Object.keys(out)){
  const c0=capBy.get(t); if(!c0)continue;
  let b=null;
  for(const S of SIZES)for(const c of ["A","B"]){
    const room=c==="A"?c0.availShort:c0.availLong; if(S>room)continue;
    const r=out[t].rows[S],d=r.cells[c+"pot"]; const v=d.gross-r.rt;
    if(!b||v>b.v)b={S,c,v};}
  if(b&&b.v>0){capped+=b.v;capital+=b.S;n++;}
}
console.log(`\n=== E. То же, но размер ограничен свободным местом на GMX (снимок): рынков ${n}, капитал ${$(capital)}, доход ${$(capped)}, APR ${(100*capped/capital).toFixed(1)}% ===`);
