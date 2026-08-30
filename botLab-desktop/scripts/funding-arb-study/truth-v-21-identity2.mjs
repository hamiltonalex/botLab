import {all,SP} from "./truth-v-lib.mjs"; import fs from "node:fs";
const OI=JSON.parse(fs.readFileSync(`${SP}/truth-v-oi.json`,"utf8"));
const YEAR=8761, full=[...all.keys()].filter(t=>all.get(t).length===YEAR);
function run(sel,label){ let e=[];
 for(const t of full){ const m=new Map(OI[t].map(([ts,L,S])=>[ts,[L,S]])); const rows=all.get(t);
  for(let i=1;i<rows.length;i++){ const r=rows[i]; if(!sel(rows,i)) continue; const o=m.get(r.tsHour); if(!o)continue;
    const [L,S]=o; if(!(L>0&&S>0))continue;
    const payLong=r.f_long<0; const fp=Math.abs(payLong?r.f_long:r.f_short), fr=Math.abs(payLong?r.f_short:r.f_long);
    if(!(fp>0&&fr>0))continue; e.push(Math.abs(fp*(payLong?L:S)/(payLong?S:L)-fr)/fr); } }
 e.sort((a,b)=>a-b);
 console.log(`${label}: часов ${e.length}, медиана ошибки ${(100*e[Math.floor(e.length/2)]).toFixed(4)}%, доля <1%: ${(100*e.filter(x=>x<0.01).length/e.length).toFixed(1)}%, доля <0.01%: ${(100*e.filter(x=>x<1e-4).length/e.length).toFixed(1)}%`); }
const changed=(rows,i)=>rows[i].f_long!==rows[i-1].f_long||rows[i].f_short!==rows[i-1].f_short;
run(changed,"часы, где ставка СМЕНИЛАСЬ (свежее состояние)");
run((r,i)=>!changed(r,i),"часы, где ставка СТОЯЛА (залежавшееся состояние)");
// внутри длинных заморозок
const runsJ=JSON.parse(fs.readFileSync(`${SP}/truth-v-runs.json`,"utf8")).filter(r=>r.n>=48);
const inRun=new Map(); for(const r of runsJ){ const s=inRun.get(r.t)||new Set(); for(let i=r.s;i<=r.e;i++) s.add(i); inRun.set(r.t,s); }
let e=[];
for(const t of full){ const S_=inRun.get(t); if(!S_)continue; const m=new Map(OI[t].map(([ts,L,S])=>[ts,[L,S]])); const rows=all.get(t);
 for(const i of S_){ const r=rows[i]; const o=m.get(r.tsHour); if(!o)continue; const [L,S]=o; if(!(L>0&&S>0))continue;
  const payLong=r.f_long<0; const fp=Math.abs(payLong?r.f_long:r.f_short), fr=Math.abs(payLong?r.f_short:r.f_long);
  if(!(fp>0&&fr>0))continue; e.push(Math.abs(fp*(payLong?L:S)/(payLong?S:L)-fr)/fr); } }
e.sort((a,b)=>a-b);
console.log(`внутри заморозок >=48ч: часов ${e.length}, медиана ошибки ${(100*e[Math.floor(e.length/2)]).toFixed(3)}%, доля <1%: ${(100*e.filter(x=>x<0.01).length/e.length).toFixed(1)}%`);
