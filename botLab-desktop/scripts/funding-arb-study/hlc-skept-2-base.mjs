import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const bin=JSON.parse(fs.readFileSync("hlc-bin-funding.json","utf8"));
const I=1e-4; // 0.01% за 8ч, номинальная процентная составляющая
let atBase=0, tot=0, perCoin=[];
const binHourly=new Map(); // coin -> Map(hourIdx -> rate/hour)
for(const [coin,o] of Object.entries(bin)){
  const rows=o.rows; if(rows.length<10) continue;
  const dts=[]; for(let i=1;i<rows.length;i++) dts.push(rows[i][0]-rows[i-1][0]);
  dts.sort((a,b)=>a-b); const iv=dts[Math.floor(dts.length/2)]/3600000; // часов в интервале
  const base=I*iv/8;
  let ab=0; for(const r of rows) if(Math.abs(r[1]-base)<1e-12) ab++;
  atBase+=ab; tot+=rows.length; perCoin.push({coin,iv,n:rows.length,pctBase:ab/rows.length,base});
  const m=new Map();
  for(const [t,r] of rows){ const endH=Math.floor(t/3600000); for(let k=0;k<iv;k++) m.set(endH-k, r/iv); }
  binHourly.set(coin,m);
}
console.log(`BINANCE: доля выплат ровно на процентной ставке 0.01%/8ч = ${(100*atBase/tot).toFixed(2)}% (${atBase}/${tot}) по ${perCoin.length} монетам`);
console.log("интервалы:", [...new Set(perCoin.map(p=>p.iv))].map(v=>`${v}ч: ${perCoin.filter(p=>p.iv===v).length} монет`).join(", "));
perCoin.sort((a,b)=>b.pctBase-a.pctBase);
console.log("доля на базе, топ/низ:", perCoin.slice(0,3).map(p=>`${p.coin} ${(100*p.pctBase).toFixed(0)}%`).join(" "), "...", perCoin.slice(-3).map(p=>`${p.coin} ${(100*p.pctBase).toFixed(0)}%`).join(" "));
// доля часов на базе у HL по тем же монетам
let hlB=0,hlT=0; for(const p of perCoin){ const rows=L.all.get(p.coin); if(!rows) continue; for(const r of rows){ hlT++; if(Math.abs(r.hl_rate-1.25e-5)<1e-12) hlB++; } }
console.log(`HYPERLIQUID: доля часов ровно на 1.25e-5 (та же 0.01%/8ч) = ${(100*hlB/hlT).toFixed(2)}% (${hlB}/${hlT})`);

// РАЗЛОЖЕНИЕ: сколько керри HL остаётся после хеджа перпом Binance (база сокращается тождественно)
console.log("\nмонета | HL шорт %/год | BIN лонг %/год | СПРЕД %/год | база HL | база BIN");
const out=[];
for(const p of perCoin){
  const rows=L.all.get(p.coin); if(!rows) continue; const bh=binHourly.get(p.coin);
  let hl=0,bn=0,n=0;
  for(const r of rows){ const h=Math.floor(r.tsHour/3600); const b=bh.get(h); if(b===undefined) continue; hl+=r.hl_rate; bn+=b; n++; }
  if(n<4000) continue;
  out.push({coin:p.coin,n,hl:hl/n*8760,bn:bn/n*8760,sp:(hl-bn)/n*8760});
}
out.sort((a,b)=>b.sp-a.sp);
for(const o of out) console.log(`${o.coin.padEnd(9)} ${L.pc(o.hl).padStart(9)} ${L.pc(-o.bn).padStart(9)} ${L.pc(o.sp).padStart(9)}   ${o.n}ч`);
const med=(a)=>L.q(a,0.5);
console.log(`\nМЕДИАНЫ по ${out.length} монетам: HL шорт ${L.pc(med(out.map(o=>o.hl)))}, хедж лонг BIN ${L.pc(-med(out.map(o=>o.bn)))}, СПРЕД ${L.pc(med(out.map(o=>o.sp)))}`);
console.log(`равновзвешенная корзина: HL ${L.pc(L.mean(out.map(o=>o.hl)))}, спред ${L.pc(L.mean(out.map(o=>o.sp)))}`);
console.log(`положительный спред у ${out.filter(o=>o.sp>0).length}/${out.length}`);
