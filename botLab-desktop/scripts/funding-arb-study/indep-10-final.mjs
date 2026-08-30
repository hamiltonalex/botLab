// Прямой ответ на три названных заказчиком размера + мера «раскачивания».
import fs from "node:fs";
import { oiTokens, loadRows, loadOi, DEFAULT_COSTS, roundTripCost, scanTwoLeg,
         openPosition, accrueFromRows, closePosition, positionSummary, SP } from "./indep-lib.mjs";
const HOUR_MS=3600e3, $=(x)=>(x<0?"-":"")+"$"+Math.abs(x).toFixed(0);
const cap=new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8")).map(c=>[c.t,c]));
const ASK=[2000,5000,10000];
function dil(rows,oi,side,S,mode){return rows.map(r=>{const s=oi.get(r.tsHour);if(!s)return r;
  const fX=side==="short"?r.f_short:r.f_long; if(!(fX>0))return r;
  const bX=side==="short"?s.bs:s.bl,bO=side==="short"?s.bl:s.bs;
  const pot=Math.max(Math.abs(r.f_long)*s.bl,Math.abs(r.f_short)*s.bs);
  const f2=(mode==="flip"&&bX+S>bO)?0:pot/(bX+S);
  return side==="short"?{...r,f_short:f2}:{...r,f_long:f2};});}
function run(rows,cfg,S){const p=openPosition({strategy:"two",instrumentKey:"x",config:cfg,capital:S,leverage:1,nowMs:rows[0].tsHour*1000,roundTripCost:0});
  const end=rows[rows.length-1].tsHour*1000+HOUR_MS; accrueFromRows(p,rows,end); closePosition(p,end);
  let f=0,b=0,h=0;for(const a of p.accruals){f+=a.fundingUsd;b+=a.borrowUsd;h+=a.dPnlHl;}
  return {g:positionSummary(p).grossPnl,f,b,h};}

// метрика «раскачивания»: доля котируемого потока, которая реально нам достаётся, и доля денег,
// пришедшихся на часы, где наш вход делает нас БОЛЬШЕЙ стороной
const keep={},flipShare={};
for(const S of ASK){keep[S]=[0,0];flipShare[S]=[0,0];}
const per=[];
for(const t of oiTokens){
  const rows=loadRows(t),oi=loadOi(t); if(!rows||rows.length!==8761)continue;
  const cfg=scanTwoLeg(rows,{token:t}).chosen, side=cfg==="A"?"short":"long";
  const rec={t,cfg};
  for(const S of ASK){
    let q=0,got=0,fm=0;
    for(const r of rows){const s=oi.get(r.tsHour);if(!s)continue;
      const fX=side==="short"?r.f_short:r.f_long; if(!(fX>0))continue;
      const bX=side==="short"?s.bs:s.bl,bO=side==="short"?s.bl:s.bs;
      const pot=Math.max(Math.abs(r.f_long)*s.bl,Math.abs(r.f_short)*s.bs)*3600;
      const quoted=fX*3600*S, real=pot*S/(bX+S);
      q+=quoted;got+=real; if(bX+S>bO)fm+=quoted;}
    keep[S][0]+=got;keep[S][1]+=q; flipShare[S][0]+=fm;flipShare[S][1]+=q;
    rec[S]={};
    for(const mode of ["none","pot","flip"]){
      const d=run(mode==="none"?rows:dil(rows,oi,side,S,mode),cfg,S);
      rec[S][mode]=d.g-roundTripCost(DEFAULT_COSTS,S,false); rec[S][mode+"_parts"]=[d.f,d.b,d.h];
    }
  }
  per.push(rec);
}
console.log("=== 1. Что реально достаётся из котируемой ставки (взвешено деньгами, все 63 рынка) ===");
for(const S of ASK)console.log(` вход $${S}: получаем ${(100*keep[S][0]/keep[S][1]).toFixed(1)}% котируемого потока; ${(100*flipShare[S][0]/flipShare[S][1]).toFixed(1)}% этого потока приходится на часы, где наш вход делает НАС большей стороной`);
console.log("\n=== 2. Итог по 63 рынкам одновременно (позиция $S в каждом, конфиг выбран движком) ===");
for(const S of ASK){let a=0,b=0,c=0,gf=0,gb=0,hl=0;
  for(const r of per){a+=r[S].none;b+=r[S].pot;c+=r[S].flip;gf+=r[S].pot_parts[0];gb+=r[S].pot_parts[1];hl+=r[S].pot_parts[2];}
  console.log(` $${String(S).padStart(6)}/рынок  капитал ${$(S*63).padStart(9)} | котируемая фантазия ${$(a).padStart(10)} | реально(потолок) ${$(b).padStart(8)} (APR ${(100*b/(S*63)).toFixed(1)}%) | строгий ${$(c).padStart(9)} | разбор: GMXфанд ${$(gf)}, borrow ${$(gb)}, HL ${$(hl)}`);}
console.log("\n=== 3. Топ-10 рынков по реальному доходу при $5000 ===");
const top=[...per].sort((x,y)=>y[5000].pot-x[5000].pot).slice(0,10);
for(const r of top){const c=cap.get(r.t);const room=r.cfg==="A"?c?.availShort:c?.availLong;
  console.log(` ${r.t.padEnd(9)}${r.cfg}  $2k ${$(r[2000].pot).padStart(7)}  $5k ${$(r[5000].pot).padStart(7)}  $10k ${$(r[10000].pot).padStart(7)} | строгий $5k ${$(r[5000].flip).padStart(7)} | котируемая фантазия $5k ${$(r[5000].none).padStart(9)} | место на GMX ${$(room||0)}`);}
for(const S of ASK){const s=top.reduce((a,r)=>a+r[S].pot,0),f=top.reduce((a,r)=>a+r[S].flip,0);
  console.log(` портфель топ-10 при $${S}: капитал ${$(10*S)}, доход ${$(s)} (APR ${(100*s/(10*S)).toFixed(1)}%), строгий ${$(f)}`);}
fs.writeFileSync(`${SP}/indep-final.json`,JSON.stringify(per));
