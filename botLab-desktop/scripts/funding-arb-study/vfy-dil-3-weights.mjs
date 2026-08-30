import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, openPosition, accrueFromRows, closePosition,
         positionSummary, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
const CLEAN = ["AAVE","ADA","ARB","AVAX","BNB","BTC","DOGE","DOT","ENA","ETH","FARTCOIN","GMX","HYPE",
  "LINK","LTC","PENDLE","PENGU","PEPE","SEI","SOL","SUI","S","TAO","TRX","UNI","VIRTUAL","XLM","XRP"];
const BASE = new Map();
for (const t of CLEAN) {
  const m = new Map();
  for (const r of JSON.parse(fs.readFileSync(`${SP}/truth-a-oi2/${t}.json`, "utf8")).oi)
    m.set(Number(r.snapshotTimestamp), { L: Number(r.longFundingBalanceOiUsd)/1e30, S: Number(r.shortFundingBalanceOiUsd)/1e30 });
  BASE.set(t, m);
}
const W=90,H=30,trainH=W*H1,holdH=H*H1;
function picks() {
  const out=[];
  for (let i=trainH;i+24<=YEAR;i+=holdH) {
    const te=Math.min(YEAR,i+holdH); if (te-i<24) break;
    const cand=[];
    for (const t of CLEAN) { const rows=all.get(t); if(!rows||rows.length!==YEAR) continue;
      const sc=scanTwoLeg(rows.slice(i-trainH,i),{token:t}); if(!sc) continue;
      const b=sc.chosen==="A"?sc.A:sc.B; if(!(b.netMedian>0)) continue; cand.push({t,cfg:sc.chosen,v:b.netMedian,i,te}); }
    cand.sort((x,y)=>y.v-x.v); out.push(cand.slice(0,3));
  }
  return out;
}
const P = picks();
const yrs=(YEAR-trainH)/8760;

// --- Пункт 2: невзвешенное среднее доли против взвешенного фактическим потоком ---
console.log("# П2. Средняя доля B/(B+S): невзвешенная против взвешенной потоком фандинга");
console.log("size $ | невзвеш. срednee | взвеш. потоком (только приход) | сдвиг");
for (const cap of [1000,10000,100000,300000]) {
  const size=cap/3; let un=0,n=0,wn=0,wd=0;
  for (const per of P) for (const s of per) {
    const rows=all.get(s.t).slice(s.i,s.te); const side=s.cfg==="A"?"S":"L"; const bm=BASE.get(s.t);
    for (const r of rows) { const o=bm.get(r.tsHour); if(!o) continue; const b=Math.max(o[side],0);
      un+=b/(b+size); n++;
      const f = side==="S"? r.f_short : r.f_long;   // ставка нашей ноги
      if (f>0) { const w=f*size; wn += w*(b/(b+size)); wd += w; } }
  }
  console.log(`$${size.toFixed(0)} | ${(100*un/n).toFixed(2)}% | ${(100*wn/wd).toFixed(2)}% | ${(100*(wn/wd-un/n)).toFixed(2)} п.п.`);
}

// --- Пункт 4: из чего складывается минус на малом капитале ---
console.log("\n# П4. Разбор минуса: газ против процентных комиссий против разбавления");
console.log("капитал | брутто без разб. | брутто с прав. разб. | цена разбавления | комиссии % | газ | опл.открытий | итог");
for (const cap of [1000,2000,5000,10000,50000,100000,300000]) {
  const size=cap/3; let g0=0,g1=0,fees=0,gas=0,opens=0,held=new Map();
  for (const per of P) {
    const now=new Map();
    for (const s of per) {
      const rows=all.get(s.t).slice(s.i,s.te); const side=s.cfg==="A"?"S":"L"; const bm=BASE.get(s.t);
      const p=openPosition({strategy:"two",instrumentKey:s.t,config:s.cfg,capital:size,leverage:1,nowMs:rows[0].tsHour*1000,roundTripCost:0});
      accrueFromRows(p,rows,rows[rows.length-1].tsHour*1000+3600000); closePosition(p,rows[rows.length-1].tsHour*1000+3600000);
      g0+=positionSummary(p).grossPnl;
      for (const a of p.accruals) { const hour=Math.floor((a.t-a.dtSec*1000)/1000/3600)*3600; const o=bm.get(hour);
        let f=a.fundingUsd||0; if(o&&f>0){const b=Math.max(o[side],0); f*=b/(b+size);} g1+=f+(a.borrowUsd||0)+(a.dPnlHl||0); }
      now.set(s.t+s.cfg,size);
    }
    for (const [k,sz] of now) if (held.get(k)!==sz) { fees+=roundTripCost(DEFAULT_COSTS,sz,false); gas+=DEFAULT_COSTS.gmxGas; opens++; }
    held=now;
  }
  console.log([`$${cap}`,(g0/yrs).toFixed(0),(g1/yrs).toFixed(0),((g1-g0)/yrs).toFixed(0),
    ((fees-gas)/yrs).toFixed(0),(gas/yrs).toFixed(0),opens,((g1-fees)/yrs).toFixed(0)].join(" | "));
}

// --- Пункт 3: перекос. Насколько наш вход сжимает поток плательщика ---
console.log("\n# П3. Перекос |L-S| на удерживаемых часах против нашего размера");
const sk=[]; const tot=[];
for (const per of P) for (const s of per) {
  const rows=all.get(s.t).slice(s.i,s.te); const bm=BASE.get(s.t);
  for (const r of rows) { const o=bm.get(r.tsHour); if(!o) continue; sk.push(Math.abs(o.L-o.S)); tot.push(o.L+o.S); }
}
sk.sort((a,b)=>a-b); tot.sort((a,b)=>a-b);
const q=(a,p)=>a[Math.floor(a.length*p)];
console.log(`часов ${sk.length}; перекос p05 $${q(sk,0.05).toFixed(0)}, медиана $${q(sk,0.5).toFixed(0)}, p95 $${q(sk,0.95).toFixed(0)}; сумма OI медиана $${q(tot,0.5).toFixed(0)}`);
console.log("size $ | доля часов где size >= перекоса (поток обнуляется/переворачивается) | медиана size/перекос");
for (const cap of [1000,10000,50000,100000,300000]) { const size=cap/3;
  const over=sk.filter(x=>size>=x).length; const rat=sk.map(x=>size/x).sort((a,b)=>a-b);
  console.log(`$${size.toFixed(0)} | ${(100*over/sk.length).toFixed(1)}% | ${q(rat,0.5).toFixed(3)}`); }
