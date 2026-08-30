import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const [meta,ctxs]=JSON.parse(fs.readFileSync("hl.json","utf8"));
let potAbs=0, potNet=0, oiTot=0, n=0; const per=[];
for(let i=0;i<meta.universe.length;i++){
  const u=meta.universe[i],c=ctxs[i]; if(u.isDelisted) continue;
  const oi=Number(c.openInterest)*Number(c.oraclePx); if(!isFinite(oi)) continue;
  oiTot+=oi; n++;
  const rows=L.all.get(u.name);
  const meanAbs = rows ? rows.reduce((s,r)=>s+Math.abs(r.hl_rate),0)/rows.length : Math.abs(Number(c.funding));
  const meanNet = rows ? rows.reduce((s,r)=>s+r.hl_rate,0)/rows.length : Number(c.funding);
  potAbs+=oi*meanAbs*8760; potNet+=oi*meanNet*8760;
  per.push({t:u.name,oi,flow:oi*meanNet*8760,inCache:!!rows});
}
per.sort((a,b)=>b.oi-a.oi);
console.log(`HL: живых рынков ${n}, суммарный открытый интерес $${(oiTot/1e9).toFixed(2)} млрд`);
console.log(`КОТЁЛ HL за год (снимок OI x средняя ставка периода): |поток| $${(potAbs/1e6).toFixed(1)} млн, чистый шортам $${(potNet/1e6).toFixed(1)} млн`);
console.log(`GMX за год (установлено ранее): $17.08 млн на 63 рынка -> HL/GMX по |потоку| = ${(potAbs/17.08e6).toFixed(1)}x`);
console.log(`\nтоп по OI:`);
for(const p of per.slice(0,10)) console.log(`  ${p.t.padEnd(8)} OI $${(p.oi/1e6).toFixed(0)}М  годовой поток шортам $${(p.flow/1e6).toFixed(2)}М ${p.inCache?"":"(нет в кэше)"}`);
const cacheFlow=per.filter(p=>p.inCache).reduce((s,p)=>s+p.flow,0);
console.log(`\nчистый поток по 93 монетам кэша: $${(cacheFlow/1e6).toFixed(1)} млн/год; их OI $${(per.filter(p=>p.inCache).reduce((s,p)=>s+p.oi,0)/1e9).toFixed(2)} млрд`);
// сколько мы можем взять, не став заметными: доля от OI
console.log(`\nразмер, равный 1% OI: BTC $${(per.find(p=>p.t==="BTC").oi*0.01/1e6).toFixed(1)}М, ETH $${(per.find(p=>p.t==="ETH").oi*0.01/1e6).toFixed(1)}М, HYPE $${(per.find(p=>p.t==="HYPE").oi*0.01/1e6).toFixed(1)}М`);
