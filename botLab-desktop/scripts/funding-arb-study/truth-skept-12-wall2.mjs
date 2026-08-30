import { TOKS, marketHours } from "./truth-skept-9-core.mjs";
const YR=3600*8760;
const all=[]; const perTok=[];
for(const t of TOKS){
  const M=marketHours(t); if(!M) continue;
  const p=[];
  for(const r of M){ const al=Math.abs(r.fl),as=Math.abs(r.fs);
    if(!(al>0&&as>0&&r.bl>0&&r.bs>0)) continue; p.push(r.bl>r.bs?al:as); }
  if(!p.length) continue;
  all.push(...p);
  // «стена с массой»: наибольшее значение, встречающееся >=24 раз побитово
  const cnt=new Map(); for(const x of p) cnt.set(x,(cnt.get(x)||0)+1);
  let wm=0; for(const [v,c] of cnt) if(c>=24 && v>wm) wm=v;
  perTok.push({t,max:Math.max(...p),wm,n:p.length});
}
all.sort((a,b)=>a-b);
const q=f=>all[Math.min(all.length-1,Math.floor(f*all.length))];
console.log("КВАНТИЛИ СТАВКИ ПЛАТЕЛЬЩИКА (плательщик = большая база), "+all.length+" часов, 63 рынка");
for(const f of [0.5,0.9,0.99,0.999,0.9999,0.99999,1]) console.log("  p"+(f*100)+"  "+q(f===1?0.999999999:f).toExponential(4)+"  "+(q(f===1?0.999999999:f)*YR*100).toFixed(2)+"% год");
console.log("  максимум "+all[all.length-1].toExponential(4)+"  "+(all[all.length-1]*YR*100).toFixed(2)+"% год");
console.log("\nчасов выше 1e-7 (порог пользователя) на стороне ПЛАТЕЛЬЩИКА:", all.filter(x=>x>1e-7).length);
perTok.sort((a,b)=>b.wm-a.wm);
console.log("\nСТЕНА С МАССОЙ (значение, встречающееся >=24 часов побитово), топ-10:");
for(const p of perTok.slice(0,10)) console.log("  "+p.t.padEnd(9)+(p.wm*YR*100).toFixed(2).padStart(8)+"%   одиночный максимум "+(p.max*YR*100).toFixed(2)+"%");
const wms=perTok.map(x=>x.wm).sort((a,b)=>a-b);
console.log("\nмаксимум СТЕНЫ С МАССОЙ по 63 рынкам: "+(wms[wms.length-1]*YR*100).toFixed(2)+"% год  ("+wms[wms.length-1].toExponential(4)+")");
console.log("медиана стены с массой: "+(wms[Math.floor(wms.length/2)]*YR*100).toFixed(2)+"%");
console.log("порог 1e-7 = "+(1e-7*YR*100).toFixed(1)+"% год; отношение к максимальной стене с массой: "+(1e-7/wms[wms.length-1]).toFixed(2)+"x");
console.log("отношение к одиночному максимуму 7.9507e-8: "+(1e-7/7.9507e-8).toFixed(2)+"x");
