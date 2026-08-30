import fs from "node:fs"; import path from "node:path";
import { parseSpreadCsv, annualizeRow, median, CACHE, SP } from "./skept-cap-lib.mjs";
const y1 = JSON.parse(fs.readFileSync(`${SP}/hlc-a-y1.json`,"utf8"));
const y2 = JSON.parse(fs.readFileSync(`${SP}/hlc-a-y2.json`,"utf8"));
const m1 = new Map(y1.map(r=>[r.token,r])), m2 = new Map(y2.map(r=>[r.token,r]));
const pc = x => (x>=0?"+":"")+(100*x).toFixed(2)+"%";
const I = 1.25e-5, BASE = I*8760;

console.log("=== 23 мажора: год1 (25.06-26.06) против года2 (23.09-25.06) ===");
console.log("TOKEN   APR_y1    APR_y2   премиальная часть y1   y2");
const p1=[],p2=[];
for (const t of [...m2.keys()].sort()) { const a=m1.get(t), b=m2.get(t); if(!a) continue;
  p1.push(a.aprShort); p2.push(b.aprShort);
  console.log(`${t.padEnd(7)} ${pc(a.aprShort).padStart(8)} ${pc(b.aprShort).padStart(9)}   ${pc(a.aprShort-BASE).padStart(9)} ${pc(b.aprShort-BASE).padStart(9)}`);
}
console.log(`медиана: y1 ${pc(median(p1))}  y2 ${pc(median(p2))}; плюсовых y1 ${p1.filter(x=>x>0).length}/${p1.length}, y2 ${p2.filter(x=>x>0).length}/${p2.length}`);
console.log(`ранговая устойчивость (Спирмен y1 vs y2): ${spear(p1,p2).toFixed(3)}`);

console.log("\n=== разложение: базовая процентная ставка i=0.00125%/ч = +10.95% год. против премиальной части ===");
for (const [name, arr] of [["y1 все 93", y1], ["y2 23 мажора", y2]]) {
  const prem = arr.map(r=>r.aprShort-BASE);
  console.log(`${name}: медиана APR ${pc(median(arr.map(r=>r.aprShort)))} = базовая ${pc(BASE)} + премия ${pc(median(prem))}; премия>0 у ${prem.filter(x=>x>0).length}/${prem.length}`);
}

console.log("\n=== идеальный выбор стороны задним числом (|APR|) против безусловного шорта ===");
for (const [name, arr] of [["y1", y1], ["y2", y2]]) {
  const abs = arr.map(r=>Math.abs(r.aprShort));
  console.log(`${name}: медиана |APR| ${pc(median(abs))} против шорта ${pc(median(arr.map(r=>r.aprShort)))}; сумма $|.| ${arr.reduce((s,r)=>s+Math.abs(r.usdShort),0).toFixed(0)} против $${arr.reduce((s,r)=>s+r.usdShort,0).toFixed(0)}`);
}

console.log("\n=== HL против GMX на тех же часах (год1, 93 монеты) ===");
const rows=[];
for (const f of fs.readdirSync(CACHE).filter(f=>f.endsWith(".csv") && !f.startsWith("_"))) {
  const t=f.replace(/_\d+_\d+\.csv$/,""); const rr=parseSpreadCsv(fs.readFileSync(path.join(CACHE,f),"utf8")).map(annualizeRow);
  const n=rr.length, mAbsHl=avg(rr.map(r=>Math.abs(r.hl_short_recv))), mAbsGf=avg(rr.map(r=>Math.abs(r.gmx_short_recv)));
  const mHl=avg(rr.map(r=>r.hl_short_recv)), mGnet=avg(rr.map(r=>r.gmx_short_recv-r.gmx_borrow_short)), mB=avg(rr.map(r=>r.gmx_borrow_short));
  rows.push({t,n,mAbsHl,mAbsGf,mHl,mGnet,mB, ratio:mAbsHl/mAbsGf});
}
console.log(`медиана |HL| ${pc(median(rows.map(r=>r.mAbsHl)))} против |GMX funding short| ${pc(median(rows.map(r=>r.mAbsGf)))} -> GMX крупнее в ${(median(rows.map(r=>r.mAbsGf))/median(rows.map(r=>r.mAbsHl))).toFixed(2)} раза (медиана отношения по монетам ${median(rows.map(r=>1/r.ratio)).toFixed(2)})`);
console.log(`медиана СРЕДНЕГО HL шорта ${pc(median(rows.map(r=>r.mHl)))} против ЧИСТОГО GMX шорта (фандинг минус borrow) ${pc(median(rows.map(r=>r.mGnet)))}; медиана borrow ${pc(median(rows.map(r=>r.mB)))}`);
console.log(`монет с чистым GMX шортом > 0: ${rows.filter(r=>r.mGnet>0).length}/${rows.length}; с HL шортом > 0: ${rows.filter(r=>r.mHl>0).length}/${rows.length}`);
const top = rows.slice().sort((a,b)=>b.mHl-a.mHl).slice(0,8);
console.log("лучшие по HL:"); for (const r of top) console.log(`  ${r.t.padEnd(8)} HL ${pc(r.mHl).padStart(9)}  GMXнетто ${pc(r.mGnet).padStart(10)}  GMXфандинг|.| ${pc(r.mAbsGf).padStart(9)}`);

function avg(a){let s=0,n=0;for(const x of a) if(Number.isFinite(x)){s+=x;n++;} return s/n;}
function spear(a,b){const r=x=>{const s=x.map((v,i)=>[v,i]).sort((p,q)=>p[0]-q[0]);const o=[];s.forEach(([_,i],k)=>o[i]=k+1);return o;};
 const ra=r(a),rb=r(b),n=a.length;let d=0;for(let i=0;i<n;i++)d+=(ra[i]-rb[i])**2;return 1-6*d/(n*(n*n-1));}
