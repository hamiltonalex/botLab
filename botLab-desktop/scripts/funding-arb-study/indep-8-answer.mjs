import fs from "node:fs"; import { SP } from "./indep-lib.mjs";
const {SIZES,out}=JSON.parse(fs.readFileSync(`${SP}/indep-fine.json`,"utf8"));
const cap=JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8"));
const capBy=new Map(cap.map(c=>[c.t,c]));
const $=(x)=>(x<0?"-":"")+"$"+Math.abs(x).toFixed(0);
const pad=(s,n)=>String(s).padStart(n);

// ---- Кривая: одинаковый размер S во ВСЕХ 63 рынках, конфиг = выбор движка (scanTwoLeg) ----
console.log("=== A. Одинаковый размер S на каждом из 63 рынков, конфиг выбран движком (scanTwoLeg на всём годе) ===");
console.log("   S/рынок   капитал |  нетто год: без разб.   потолок   строгий | из них GMX-фандинг(pot)  GMX-borrow  HL-фандинг");
for(const S of SIZES){
  let none=0,pot=0,flip=0,gf=0,gb=0,hl=0;
  for(const t of Object.keys(out)){const r=out[t].rows[S],c=out[t].eng;
    none+=r.cells[c+"none"].gross-r.rt; pot+=r.cells[c+"pot"].gross-r.rt; flip+=r.cells[c+"flip"].gross-r.rt;
    gf+=r.cells[c+"pot"].f; gb+=r.cells[c+"pot"].b; hl+=r.cells[c+"pot"].h;}
  console.log(`${pad(S,10)} ${pad(S*63,9)} | ${pad($(none),13)} ${pad($(pot),9)} ${pad($(flip),9)} | ${pad($(gf),12)} ${pad($(gb),11)} ${pad($(hl),11)}`);
}
// ---- Оптимум по размеру, суммарно ----
function best(sel){let b=null;for(const S of SIZES){const v=sel(S);if(!b||v.v>b.v)b={S,...v};}return b;}
const sum=(S,mode,part)=>{let s=0;for(const t of Object.keys(out)){const r=out[t].rows[S],c=out[t].eng;
  const d=r.cells[c+mode]; s+= part==="all"? d.gross-r.rt : part==="gmx"? d.f+d.b-r.rt : d.h;}return s;};
console.log("\n=== B. Оптимальный ЕДИНЫЙ размер ===");
for(const [mode,part,label] of [["pot","all","весь нетто пары, потолок"],["flip","all","весь нетто пары, строгий"],
  ["pot","gmx","только GMX-нога (фандинг-borrow-издержки), потолок"],["flip","gmx","только GMX-нога, строгий"]]){
  const b=best(S=>({v:sum(S,mode,part)}));
  console.log(`${label.padEnd(52)} S*=${pad("$"+b.S,10)}  капитал ${pad("$"+b.S*63,10)}  доход ${pad($(b.v),10)}  APR ${(100*b.v/(b.S*63)).toFixed(1)}%`);
}
// ---- Пер-рыночный оптимум (совершенное предвидение размера И конфига) ----
console.log("\n=== C. Верхняя оценка: свой оптимальный размер и конфиг на каждом рынке (предвидение) ===");
for(const [mode,part] of [["pot","all"],["flip","all"],["pot","gmx"],["flip","gmx"]]){
  let tot=0,capTot=0,n=0,detail=[];
  for(const t of Object.keys(out)){
    let b=null;
    for(const S of SIZES)for(const c of ["A","B"]){const r=out[t].rows[S],d=r.cells[c+mode];
      const v= part==="all"? d.gross-r.rt : d.f+d.b-r.rt;
      if(!b||v>b.v)b={S,c,v};}
    if(b.v>0){tot+=b.v;capTot+=b.S;n++;detail.push({t,...b});}
  }
  detail.sort((a,b)=>b.v-a.v);
  console.log(`режим=${mode} часть=${part}: рынков в плюсе ${n}/63, капитал $${capTot.toLocaleString()}, доход ${$(tot)}, APR ${(100*tot/capTot).toFixed(1)}%`);
  if(part==="all"&&mode==="pot") console.log("   топ-8: "+detail.slice(0,8).map(d=>`${d.t}/${d.c} $${d.S}->${$(d.v)}`).join("  "));
}
// ---- Ёмкость GMX по снимку ----
console.log("\n=== D. Свободное место на GMX (снимок cap63): сколько вообще можно открыть ===");
const av=cap.map(c=>({t:c.t,short:c.availShort,long:c.availLong})).sort((a,b)=>b.short-a.short);
console.log("медиана availShort $"+av.map(a=>a.short).sort((x,y)=>x-y)[31].toFixed(0)+
            ", медиана availLong $"+cap.map(c=>c.availLong).sort((x,y)=>x-y)[31].toFixed(0));
let lt=0;for(const c of cap) if(Math.min(c.availShort,c.availLong)<10000) lt++;
console.log(`рынков, где свободное место хотя бы с одной стороны < $10k: ${lt}/63`);
