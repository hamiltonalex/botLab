import fs from "node:fs"; import { SP } from "./indep-lib.mjs";
const {SIZES,out}=JSON.parse(fs.readFileSync(`${SP}/indep-fine.json`,"utf8"));
const cap=new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8")).map(c=>[c.t,c]));
const $=(x)=>(x<0?"-":"")+"$"+Math.abs(x).toFixed(0);
for(const mode of ["pot","flip"]){
  let tot=0,capital=0,gf=0,gb=0,hl=0,n=0,det=[];
  for(const t of Object.keys(out)){
    const c0=cap.get(t); if(!c0)continue; let b=null;
    for(const S of SIZES)for(const c of ["A","B"]){
      const room=c==="A"?c0.availShort:c0.availLong; if(S>room)continue;
      const r=out[t].rows[S],d=r.cells[c+mode]; const v=d.gross-r.rt;
      if(!b||v>b.v)b={S,c,v,d};}
    if(b&&b.v>0){tot+=b.v;capital+=b.S;n++;gf+=b.d.f;gb+=b.d.b;hl+=b.d.h;det.push({t,...b});}
  }
  det.sort((a,b)=>b.v-a.v);
  console.log(`ПОТОЛОК (${mode}, предвидение размера+конфига, размер ограничен местом на GMX): рынков ${n}, капитал ${$(capital)}, доход ${$(tot)}, APR ${(100*tot/capital).toFixed(1)}%`);
  console.log(`   разбор: GMX-фандинг ${$(gf)}, GMX-borrow ${$(gb)}, HL-фандинг ${$(hl)}`);
  console.log("   топ-6: "+det.slice(0,6).map(d=>`${d.t}/${d.c} $${d.S}->${$(d.v)}`).join("  "));
}
