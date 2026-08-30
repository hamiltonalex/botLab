// Проверка flip.mjs: тот же порог |L-S|, но (1) независимо пересчитан, (2) взвешен деньгами,
// (3) на размерах, о которых спрашивает заказчик, (4) сторона определена ЗНАКОМ ставки.
import { loadRows, loadOi } from "./indep-lib.mjs";
const EARN=["PENGU","BNB","DOT","PEPE","SEI","TAO","TRX","VIRTUAL","LINK","XRP","ADA"];
const SZ=[2000,5000,10000,100000];
console.log("рынок     нужно_для_переворота(медиана |L-S|)  |  доля ЧАСОВ, где размер переворачивает  |  доля ДЕНЕГ принимающей ноги в тех же часах");
console.log("                                                  "+SZ.map(s=>("$"+s).padStart(8)).join("")+"   "+SZ.map(s=>("$"+s).padStart(8)).join(""));
const agg={h:{},m:{}}; for(const s of SZ){agg.h[s]=[0,0];agg.m[s]=[0,0];}
for(const t of EARN){
  const rows=loadRows(t), oi=loadOi(t); if(!rows) continue;
  const gaps=[]; const hc={},mc={}; for(const s of SZ){hc[s]=[0,0];mc[s]=[0,0];}
  for(const r of rows){
    const o=oi.get(r.tsHour); if(!o||!(o.bl>0)||!(o.bs>0))continue;
    const gap=Math.abs(o.bl-o.bs); gaps.push(gap);
    // принимающая сторона по ЗНАКУ ставки
    const recvShort=r.f_short>0, recvLong=r.f_long>0;
    const pot=Math.max(Math.abs(r.f_long)*o.bl,Math.abs(r.f_short)*o.bs)*3600;
    for(const s of SZ){ hc[s][1]++; if(s>gap)hc[s][0]++;
      if(recvShort||recvLong){ mc[s][1]+=pot; if(s>gap)mc[s][0]+=pot; } }
  }
  gaps.sort((a,b)=>a-b); const medGap=gaps[gaps.length>>1];
  for(const s of SZ){agg.h[s][0]+=hc[s][0];agg.h[s][1]+=hc[s][1];agg.m[s][0]+=mc[s][0];agg.m[s][1]+=mc[s][1];}
  console.log(t.padEnd(9)+("$"+medGap.toFixed(0)).padStart(14)+"                      "+
    SZ.map(s=>((100*hc[s][0]/hc[s][1]).toFixed(1)+"%").padStart(8)).join("")+"   "+
    SZ.map(s=>((100*mc[s][0]/mc[s][1]).toFixed(1)+"%").padStart(8)).join(""));
}
console.log("\nИТОГО по 11 именам:  часы "+SZ.map(s=>((100*agg.h[s][0]/agg.h[s][1]).toFixed(1)+"%").padStart(8)).join("")+
  "   деньги "+SZ.map(s=>((100*agg.m[s][0]/agg.m[s][1]).toFixed(1)+"%").padStart(8)).join(""));
