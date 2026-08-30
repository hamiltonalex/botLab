import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const bin=JSON.parse(fs.readFileSync("hlc-bin-funding.json","utf8"));
const I=1e-4;
const rows=[];
for(const [coin,o] of Object.entries(bin)){
  const rr=o.rows; if(rr.length<100) continue;
  const dts=[]; for(let i=1;i<rr.length;i++) dts.push(rr[i][0]-rr[i-1][0]); dts.sort((a,b)=>a-b);
  const iv=dts[Math.floor(dts.length/2)]/3600000; const base=I*iv/8;
  const hl=L.all.get(coin); if(!hl) continue;
  const m=new Map(); for(const [t,r] of rr){ const e=Math.floor(t/3600000); for(let k=0;k<iv;k++) m.set(e-k,{r:r/iv,b:base/iv}); }
  let hlP=0,bnP=0,n=0,hlB=0,bnB=0;
  for(const x of hl){ const h=Math.floor(x.tsHour/3600); const b=m.get(h); if(!b) continue;
    n++; hlP+=x.hl_rate-1.25e-5; bnP+=b.r-b.b; hlB+=1.25e-5; bnB+=b.b; }
  if(n<4000) continue;
  rows.push({coin,n,hlB:hlB/n*8760,hlP:hlP/n*8760,bnB:bnB/n*8760,bnP:bnP/n*8760});
}
console.log("РАЗЛОЖЕНИЕ СПРЕДА (шорт HL / лонг Binance), %/год");
console.log("монета   база HL   премия HL   база BIN   премия BIN   СПРЕД=премHL-премBIN");
for(const r of rows.sort((a,b)=>(b.hlP-b.bnP)-(a.hlP-a.bnP)))
  console.log(`${r.coin.padEnd(9)} ${L.pc(r.hlB).padStart(8)} ${L.pc(r.hlP).padStart(10)} ${L.pc(r.bnB).padStart(10)} ${L.pc(r.bnP).padStart(11)} ${L.pc(r.hlP-r.bnP).padStart(12)}`);
const md=(f)=>L.q(rows.map(f),0.5);
console.log(`\nМЕДИАНЫ: база HL ${L.pc(md(r=>r.hlB))} = база BIN ${L.pc(md(r=>r.bnB))} (сокращается тождественно)`);
console.log(`премия HL ${L.pc(md(r=>r.hlP))}, премия BIN ${L.pc(md(r=>r.bnP))}, СПРЕД ${L.pc(md(r=>r.hlP-r.bnP))}`);
console.log(`база сокращена: остаток ${L.pc(md(r=>r.hlB-r.bnB))}`);
// сколько монет имеют ПОЛОЖИТЕЛЬНУЮ рыночную премию на HL (год 1, все 93)
let posP=0,tot=0; const lst=[];
for(const [t,rr] of L.all){ const p=rr.reduce((s,x)=>s+x.hl_rate-1.25e-5,0)/rr.length*8760; tot++; if(p>0){posP++; lst.push(`${t} ${L.pc(p)}`);} }
console.log(`\nмонет из ${tot} с ПОЛОЖИТЕЛЬНОЙ рыночной (премиальной) составляющей за год 1: ${posP} -> ${lst.join(", ")}`);
