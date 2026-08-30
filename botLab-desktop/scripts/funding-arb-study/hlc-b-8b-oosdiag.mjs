import { SP, parseSpreadCsv } from "./skept-cap-lib.mjs";
import fs from "node:fs";
const I=1e-4,C=5e-4,K=8; const f=(p)=>(p+Math.max(-C,Math.min(C,I-p)))/K;
let n=0, bad=[], byMonth=new Map();
for (const file of fs.readdirSync(`${SP}/y2`).filter(x=>x.endsWith(".csv"))) {
  const t=file.replace(".csv","");
  for (const r of parseSpreadCsv(fs.readFileSync(`${SP}/y2/${file}`,"utf8"))) {
    if(!Number.isFinite(r.hl_rate)||!Number.isFinite(r.hl_premium))continue; n++;
    const e=Math.abs(r.hl_rate-f(r.hl_premium));
    const m=String(r.ts).slice(0,7);
    const b=byMonth.get(m)||{n:0,bad:0,mx:0}; b.n++; if(e>1e-10){b.bad++; if(e>b.mx)b.mx=e;} byMonth.set(m,b);
    if(e>1e-10) bad.push({t,ts:r.ts,p:r.hl_premium,r:r.hl_rate,pred:f(r.hl_premium),e});
  }
}
console.log(`y2: часов ${n}, отклонений > 1e-10: ${bad.length} = ${(100*bad.length/n).toFixed(4)}%`);
bad.sort((a,b)=>b.e-a.e);
console.log("худшие 8:"); for(const b of bad.slice(0,8)) console.log(`  ${b.t.padEnd(7)} ${b.ts}  P=${b.p}  rate=${b.r}  модель=${b.pred.toExponential(6)}  err=${b.e.toExponential(2)}`);
console.log("\nпо месяцам (только месяцы с отклонениями):");
for (const [m,b] of [...byMonth].sort()) if(b.bad) console.log(`  ${m}: ${b.bad}/${b.n} = ${(100*b.bad/b.n).toFixed(2)}%  max ${b.mx.toExponential(2)}`);
// сколько отклонений объясняются нулевой/отсутствующей премией
const zero=bad.filter(b=>b.p===0).length;
console.log(`\nиз них с hl_premium ровно 0 (премия не записана): ${zero} = ${(100*zero/Math.max(bad.length,1)).toFixed(1)}%`);
