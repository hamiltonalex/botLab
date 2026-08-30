import fs from "node:fs"; import path from "node:path";
import { parseSpreadCsv, median, CACHE, SP } from "./skept-cap-lib.mjs";
const I=1.25e-5;
const pool=[]; const majors=["BTC","ETH","SOL","LINK","AAVE","UNI","DOGE","LTC","NEAR","ARB"];
const majPool=[];
for (const f of fs.readdirSync(CACHE).filter(f=>f.endsWith(".csv")&&!f.startsWith("_"))) {
  const t=f.replace(/_\d+_\d+\.csv$/,"");
  for (const r of parseSpreadCsv(fs.readFileSync(path.join(CACHE,f),"utf8"))) if(Number.isFinite(r.hl_rate)){
    pool.push(r.hl_rate); if(majors.includes(t)) majPool.push(r.hl_rate);}
}
const q=(a,p)=>{const f=a.slice().sort((x,y)=>x-y);return f[Math.min(f.length-1,Math.floor(p*f.length))];};
const show=(name,a)=>{const A=x=>(100*x*8760).toFixed(1)+"%";
  console.log(`${name}: n=${a.length} p0.1 ${A(q(a,0.001))} p1 ${A(q(a,0.01))} p5 ${A(q(a,0.05))} p25 ${A(q(a,0.25))} медиана ${A(q(a,0.5))} p75 ${A(q(a,0.75))} p95 ${A(q(a,0.95))} p99 ${A(q(a,0.99))} p99.9 ${A(q(a,0.999))}`);
  console.log(`   среднее ${A(a.reduce((s,x)=>s+x,0)/a.length)}; доля часов ровно на i ${(100*a.filter(x=>Math.abs(x-I)<1e-12).length/a.length).toFixed(1)}%; доля<0 ${(100*a.filter(x=>x<0).length/a.length).toFixed(1)}%`);
  const neg=a.filter(x=>x<0).reduce((s,x)=>s+x,0), pos=a.filter(x=>x>0).reduce((s,x)=>s+x,0);
  console.log(`   суммарно плюс ${A(pos/a.length)} минус ${A(neg/a.length)} (в годовых на час)`);};
show("все 93 монеты", pool); show("10 мажоров", majPool);
