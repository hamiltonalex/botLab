import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, openPosition, accrueFromRows, closePosition,
         positionSummary, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
const CLEAN = ["AAVE","ADA","ARB","AVAX","BNB","BTC","DOGE","DOT","ENA","ETH","FARTCOIN","GMX","HYPE",
  "LINK","LTC","PENDLE","PENGU","PEPE","SEI","SOL","SUI","S","TAO","TRX","UNI","VIRTUAL","XLM","XRP"];
const BASE=new Map();
for (const t of CLEAN){const m=new Map();
  for (const r of JSON.parse(fs.readFileSync(`${SP}/truth-a-oi2/${t}.json`,"utf8")).oi)
    m.set(Number(r.snapshotTimestamp),{L:Number(r.longFundingBalanceOiUsd)/1e30,S:Number(r.shortFundingBalanceOiUsd)/1e30});
  BASE.set(t,m);}
const W=90,H=30,trainH=W*H1,holdH=H*H1,yrs=(YEAR-trainH)/8760;
const P=[];
for(let i=trainH;i+24<=YEAR;i+=holdH){const te=Math.min(YEAR,i+holdH);if(te-i<24)break;const c=[];
  for(const t of CLEAN){const rows=all.get(t);if(!rows||rows.length!==YEAR)continue;
    const sc=scanTwoLeg(rows.slice(i-trainH,i),{token:t});if(!sc)continue;const b=sc.chosen==="A"?sc.A:sc.B;
    if(!(b.netMedian>0))continue;c.push({t,cfg:sc.chosen,v:b.netMedian,i,te});}
  c.sort((x,y)=>y.v-x.v);P.push(c.slice(0,3));}

// П3: сверху разбавления добавляем сжатие перекоса (статическая модель GMX: f_pay ~ skew/totalOI)
console.log("# П3. Итог с учётом сжатия перекоса (верхняя граница эффекта)");
console.log("капитал | только разбавление $/год | + сжатие перекоса $/год");
for (const cap of [1000,2000,5000,10000,50000,100000,300000]) {
  const size=cap/3; let g1=0,g2=0,fees=0,held=new Map();
  for (const per of P){const now=new Map();
    for (const s of per){const rows=all.get(s.t).slice(s.i,s.te);const side=s.cfg==="A"?"S":"L";const bm=BASE.get(s.t);
      const p=openPosition({strategy:"two",instrumentKey:s.t,config:s.cfg,capital:size,leverage:1,nowMs:rows[0].tsHour*1000,roundTripCost:0});
      accrueFromRows(p,rows,rows[rows.length-1].tsHour*1000+3600000);closePosition(p,rows[rows.length-1].tsHour*1000+3600000);
      for(const a of p.accruals){const hour=Math.floor((a.t-a.dtSec*1000)/1000/3600)*3600;const o=bm.get(hour);
        const rest=(a.borrowUsd||0)+(a.dPnlHl||0);let f=a.fundingUsd||0,f2=f;
        if(o&&f>0){const b=Math.max(o[side],0);const dil=b/(b+size);f*=dil;
          const skew=Math.abs(o.L-o.S),tot=o.L+o.S;
          const comp=Math.max(0,1-size/Math.max(skew,1e-9))*(tot/(tot+size));
          f2*=dil*comp;}
        g1+=f+rest;g2+=f2+rest;}
      now.set(s.t+s.cfg,size);}
    for(const [k,sz] of now) if(held.get(k)!==sz) fees+=roundTripCost(DEFAULT_COSTS,sz,false);
    held=now;}
  console.log(`$${cap} | ${((g1-fees)/yrs).toFixed(0)} | ${((g2-fees)/yrs).toFixed(0)}`);
}

// П5: потолок ёмкости GMX по именам, которые реально выбираются
const cap63=JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8"));
const byT=new Map(cap63.map(r=>[r.t,r]));
const used=new Map();
for(const per of P) for(const s of per){const k=s.t+"/"+s.cfg;used.set(k,(used.get(k)||0)+1);}
console.log("\n# П5. Ёмкость GMX (availLong/availShort из cap63) для реально выбранных имён");
const rowsOut=[...used.entries()].map(([k,n])=>{const [t,cfg]=k.split("/");const c=byT.get(t);
  const room=c?(cfg==="A"?c.availShort:c.availLong):NaN;return {t,cfg,n,room};}).sort((a,b)=>a.room-b.room);
for(const r of rowsOut) console.log(`${r.t} cfg${r.cfg} взят ${r.n} раз | свободный OI на нашей стороне $${Number(r.room).toFixed(0)}`);
const mins=rowsOut.map(r=>r.room).filter(Number.isFinite).sort((a,b)=>a-b);
console.log(`минимальная ёмкость среди выбранных $${mins[0].toFixed(0)}; при капитале $1000 слот $333, при $300000 слот $100000`);
