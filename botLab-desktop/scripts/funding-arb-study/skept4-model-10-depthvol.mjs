import { DATA as STUDY_DATA } from "./paths.mjs";
// А4. Обоснована ли поправка глубины по обороту. Временных снимков книги нет, но есть
// ПОПЕРЕЧНИК: 63 имени в один момент. Если глубина ~ оборот^k, то k видно по срезу.
import fs from "node:fs";
const SP=STUDY_DATA;
const H=JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`,"utf8"));
const pts=[];
for(const [t,d] of Object.entries(H.tokens)){
  const v=d.volume?.todayNtl, r=d.raw;
  if(!(v>0)||!r)continue;
  const dep=Math.min(r.buy.ntlAtBps?.["25"]??0, r.sell.ntlAtBps?.["25"]??0);
  const vis=Math.min(r.buy.visibleNtl,r.sell.visibleNtl);
  if(dep>0)pts.push({t,v,dep,vis,med:d.volume.medPeriodNtl});
}
function reg(xs,ys){const n=xs.length,mx=xs.reduce((a,b)=>a+b)/n,my=ys.reduce((a,b)=>a+b)/n;
  let sxy=0,sxx=0,syy=0; for(let i=0;i<n;i++){sxy+=(xs[i]-mx)*(ys[i]-my);sxx+=(xs[i]-mx)**2;syy+=(ys[i]-my)**2;}
  return {k:sxy/sxx,r:sxy/Math.sqrt(sxx*syy),n};}
for(const [lbl,f] of [["глубина до 25 бп",p=>p.dep],["весь видимый стакан",p=>p.vis]]){
  const a=reg(pts.map(p=>Math.log10(p.v)),pts.map(p=>Math.log10(f(p))));
  console.log(`${lbl} против СЕГОДНЯШНЕГО оборота: показатель k=${a.k.toFixed(3)} (глубина ~ оборот^k), корр ${a.r.toFixed(3)}, n=${a.n}`);
  const b=reg(pts.map(p=>Math.log10(p.med)),pts.map(p=>Math.log10(f(p))));
  console.log(`${lbl} против МЕДИАННОГО оборота периода: k=${b.k.toFixed(3)}, корр ${b.r.toFixed(3)}`);
}
console.log("\nпоправка прогона использует k=0.5 (корневая) и k=1.0 (линейная).");
// Насколько поправка вообще меняет цену круга на РАБОЧЕМ размере
const med=xs=>{const s=xs.slice().sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
for(const X of [10000,25000,50000,100000]){
  const i=H.meta.xs.indexOf(X);
  const g=v=>med(Object.values(H.tokens).map(d=>{const q=d[v]; if(!q)return null;
    const a=q.buy.bps[i],b=q.sell.bps[i]; return Number.isFinite(a)&&Number.isFinite(b)?a+b:null;}).filter(x=>x!=null));
  console.log(`  X=$${X.toLocaleString("en-US")}: сырой ${g("raw").toFixed(1)} бп, корневой ${g("correctedSqrt").toFixed(1)}, линейный ${g("correctedLinear").toFixed(1)}`);
}
