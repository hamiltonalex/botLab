import {all,SP} from "./truth-v-lib.mjs"; import fs from "node:fs";
const OI=JSON.parse(fs.readFileSync(`${SP}/truth-v-oi.json`,"utf8"));
const YEAR=8761, full=[...all.keys()].filter(t=>all.get(t).length===YEAR);
// тождество: |f_получателя| = |f_плательщика| * OI_плательщика / OI_получателя ?
let n=0, err=[];
for(const t of full){ const m=new Map(OI[t].map(([ts,L,S])=>[ts,[L,S]]));
  for(const r of all.get(t)){ const o=m.get(r.tsHour); if(!o) continue;
    const [L,S]=o; if(!(L>0&&S>0)) continue;
    const payLong=r.f_long<0; const fp=Math.abs(payLong?r.f_long:r.f_short), fr=Math.abs(payLong?r.f_short:r.f_long);
    const oiP=payLong?L:S, oiR=payLong?S:L; if(!(fp>0&&fr>0)) continue;
    const pred=fp*oiP/oiR; n++; err.push(Math.abs(pred-fr)/fr); } }
err.sort((a,b)=>a-b);
const Q=p=>err[Math.floor(p*err.length)];
console.log(`проверено часов с OI обеих сторон: ${n}`);
console.log(`относительная ошибка тождества |f_recv| = |f_pay| * OI_pay/OI_recv :`);
for(const p of [0.5,0.75,0.9,0.95,0.99]) console.log(`  p${(100*p).toString().padEnd(4)} ${(100*Q(p)).toFixed(3)}%`);
console.log(`доля часов, где ошибка < 1%: ${(100*err.filter(x=>x<0.01).length/n).toFixed(1)}%`);
console.log(`доля часов, где ошибка < 5%: ${(100*err.filter(x=>x<0.05).length/n).toFixed(1)}%`);
