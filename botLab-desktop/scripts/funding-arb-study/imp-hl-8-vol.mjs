import fs from "node:fs";
import {vol,cap,books,ctx,med} from "./imp-hl-3-curve.mjs";
const rs=[];
for(const row of cap){
  const c=ctx.get(books[row.t].coin);
  const series=(vol[row.t]||[]).map(d=>d.ntl).filter(x=>x>0);
  if(!series.length||!c) continue;
  const mp=med(series), today=+c.dayNtlVlm;
  rs.push({t:row.t,days:series.length,medPeriod:mp,today,ratio:today/mp});
}
rs.sort((a,b)=>a.ratio-b.ratio);
console.log("монет:",rs.length,"  медиана отношения сегодня/медиана периода:",med(rs.map(r=>r.ratio)).toFixed(3));
const q=(p)=>{const s=rs.map(r=>r.ratio).sort((a,b)=>a-b);return s[Math.floor(p*(s.length-1))];};
console.log("квантили отношения: 10%",q(.1).toFixed(2)," 25%",q(.25).toFixed(2)," 50%",q(.5).toFixed(2)," 75%",q(.75).toFixed(2)," 90%",q(.9).toFixed(2));
console.log("сегодня тоньше медианы периода у",rs.filter(r=>r.ratio<1).length,"из",rs.length,"монет");
console.log();
console.log("самые тонкие сегодня (ratio):"); rs.slice(0,6).forEach(r=>console.log("  ",r.t.padEnd(10),r.ratio.toFixed(3),"мед$"+Math.round(r.medPeriod).toLocaleString("en"),"сег$"+Math.round(r.today).toLocaleString("en")));
console.log("самые толстые сегодня:"); rs.slice(-6).forEach(r=>console.log("  ",r.t.padEnd(10),r.ratio.toFixed(3),"мед$"+Math.round(r.medPeriod).toLocaleString("en"),"сег$"+Math.round(r.today).toLocaleString("en")));
console.log();
console.log("множители глубины: линейный 1/ratio, корневой 1/sqrt(ratio)");
console.log("  медиана линейного",med(rs.map(r=>1/r.ratio)).toFixed(2),"  медиана корневого",med(rs.map(r=>1/Math.sqrt(r.ratio))).toFixed(2));
console.log("  доля монет, где линейный >5x:",rs.filter(r=>1/r.ratio>5).length);
