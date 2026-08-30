// СКЕПТИК, батарея 5: НАСТОЯЩИЙ прогон -> настоящие стороны, настоящие размеры, деньги.
// Правила зовутся из движка (scanTwoLeg / openPosition / accrueFromRows / positionSummary / roundTripCost).
import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, annualizeRow, maxOf, openPosition, accrueFromRows,
         closePosition, positionSummary, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
const cap63=JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8"));
const CAP=new Map(cap63.map(r=>[r.t,r]));
const VOL=JSON.parse(fs.readFileSync(`${SP}/vol63.json`,"utf8"));
const med=xs=>{const a=xs.slice().sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):NaN;};
const q=(a,p)=>{const x=a.slice().sort((u,v)=>u-v);if(!x.length)return NaN;const i=(x.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return x[lo]+(x[hi]-x[lo])*(i-lo);};
const W=90,H=30,trainH=W*H1,holdH=H*H1;
const PER=[];for(let i=trainH;i+24<=YEAR;i+=holdH){const te=Math.min(YEAR,i+holdH);if(te-i<24)break;PER.push([i,te]);}
const YRS=(PER[PER.length-1][1]-trainH)/8760;
const anchor=cap63[0].t;
const TAB=PER.map(([i,te])=>{
  const t0=all.get(anchor)[i-trainH].tsHour*1000,t1=all.get(anchor)[i].tsHour*1000;const m=new Map();
  for(const t of CAP.keys()){const rows=all.get(t);if(!rows||rows.length!==YEAR)continue;
    const sc=scanTwoLeg(rows.slice(i-trainH,i),{token:t});if(!sc)continue;
    const b=sc.chosen==="A"?sc.A:sc.B;const v=b.netMedian;if(!(v>0))continue;
    const w=rows.slice(i,te);
    const p=openPosition({strategy:"two",instrumentKey:t,config:sc.chosen,capital:1,leverage:1,nowMs:w[0].tsHour*1000,roundTripCost:0});
    accrueFromRows(p,w,w[w.length-1].tsHour*1000+3600000);closePosition(p,w[w.length-1].tsHour*1000+3600000);
    const vs=(VOL[t]||[]).filter(c=>c.t>=t0&&c.t<t1).map(c=>c.ntl).filter(Number.isFinite);
    const pk=maxOf(rows.slice(i-trainH,i).map(annualizeRow).map(a=>Math.max(Math.abs(a.net_A),Math.abs(a.net_B))));
    m.set(t,{cfg:sc.chosen,v,g1:positionSummary(p).grossPnl,hlTrail:vs.length>=10?med(vs):NaN,peak:pk});}
  return m;});
function bottleneck(t,cfg,hlTrail,share){const r=CAP.get(t);const a=cfg==="A"?r.availShort:r.availLong;
  return Math.min(a,Number.isFinite(hlTrail)?hlTrail*share:0);}
// прогон капитала $300k, N=3 (слот = ровно $100k, как в утверждении)
const capital=300000,N=3,K=8,share=0.01,margin=5,sane=10;
const HOLD=[]; let gross=0,fees=0,held=new Map();
for(let pi=0;pi<TAB.length;pi++){const m=TAB[pi];const [i,te]=PER[pi];
  const cand=[...m.entries()].filter(([,d])=>Number.isFinite(d.peak)&&d.peak<=sane)
    .map(([t,d])=>({t,...d,b:bottleneck(t,d.cfg,d.hlTrail,share)})).sort((a,b)=>b.v-a.v);
  let left=capital;const now=new Map();
  for(const s of cand){if(now.size>=K||left<=1)break;
    const size=Math.min(capital/N,s.b/margin,left);if(size<capital/100)continue;
    now.set(s.t+s.cfg,size);left-=size;gross+=s.g1*size;
    HOLD.push({t:s.t,cfg:s.cfg,size,i,te});}
  for(const [k,sz] of now) if(held.get(k)!==sz){fees+=roundTripCost(DEFAULT_COSTS,sz,false);}
  held=now;}
console.log(`# Прогон: капитал $${capital}, N=${N} (слот $${capital/N}), K=${K}, доля HL ${share}, запас ${margin}x, вменяемость <=${sane}`);
console.log(`# нетто $${((gross-fees)/YRS).toFixed(0)}/год, позиций-периодов ${HOLD.length}\n`);

const EARN=["PENGU","BNB","DOT","PEPE","SEI","TAO","TRX","VIRTUAL","LINK","XRP","ADA"];
console.log("== 4а. НАСТОЯЩИЕ РАЗМЕРЫ И СТОРОНЫ, которые прогон ставит ==");
console.log("| рынок | взятий | медиана размера | конфиг(ы) | доля периодов A (шорт GMX) |");
console.log("|---|---|---|---|---|");
for(const t of EARN){const h=HOLD.filter(x=>x.t===t);if(!h.length){console.log(`| ${t} | 0 | - | - | - |`);continue;}
  const a=h.filter(x=>x.cfg==="A").length;
  console.log(`| ${t} | ${h.length} | $${med(h.map(x=>x.size)).toFixed(0)} | ${[...new Set(h.map(x=>x.cfg))].join("/")} | ${(100*a/h.length).toFixed(0)}% |`);}

// почасовая оценка на РЕАЛЬНЫХ часах удержания
const OI=new Map();for(const t of EARN)OI.set(t,new Map(JSON.parse(fs.readFileSync(`${SP}/truth-a-oi2/${t}.json`,"utf8")).oi.map(r=>[r.snapshotTimestamp,r])));
console.log("\n== 4б/2б. ПО ФАКТИЧЕСКИ УДЕРЖИВАЕМЫМ ЧАСАМ ==");
console.log("| рынок | часов | наша сторона УЖЕ больше | переворот реальным размером | переворот при $100k | наша сторона получает |");
console.log("|---|---|---|---|---|---|");
const MONEY=[];
for(const t of EARN){
  const h=HOLD.filter(x=>x.t===t);if(!h.length)continue;
  const rows=all.get(t);const oim=OI.get(t);
  let tot=0,already=0,flipReal=0,flip100=0,recv=0;
  let usdFlip=0,usdAll=0,gmxFlip=0;
  for(const p of h){
    for(let k=p.i;k<p.te;k++){
      const r=rows[k];const o=oim.get(r.tsHour);if(!o)continue;
      const L=+o.longFundingBalanceOiUsd/1e30,S=+o.shortFundingBalanceOiUsd/1e30;if(!(L>0&&S>0))continue;
      const ourB=p.cfg==="A"?S:L, oppB=p.cfg==="A"?L:S;
      const ann=annualizeRow(r);
      const net=p.cfg==="A"?ann.net_A:ann.net_B;
      const gmxLeg=p.cfg==="A"?ann.gmx_short_recv:ann.gmx_long_recv;
      tot++; if(gmxLeg>0)recv++;
      usdAll+=p.size*net/8760;
      if(ourB>=oppB){already++;}
      else{ if(p.size>oppB-ourB){flipReal++; usdFlip+=p.size*net/8760; gmxFlip+=p.size*gmxLeg/8760;}
            if(100000>oppB-ourB)flip100++; }
    }
  }
  MONEY.push({t,usdAll,usdFlip,gmxFlip,tot,flipReal});
  console.log(`| ${t} | ${tot} | ${(100*already/tot).toFixed(1)}% | ${(100*flipReal/tot).toFixed(1)}% | ${(100*(flip100+already)/tot).toFixed(1)}%* | ${(100*recv/tot).toFixed(1)}% |`);
}
console.log("  * для колонки $100k «уже больше» тоже считается перевёрнутым (мы и так на большей стороне)");

console.log("\n== 5. ДЕНЬГИ: сколько валовой прибыли сидит в часах, где мы сами переворачиваем перекос ==");
console.log("| рынок | валовая $/год всего | из них в перевёрнутых часах | цена разворота знака (2x нога GMX), $/год |");
console.log("|---|---|---|---|");
let A=0,B=0,C=0;
for(const m of MONEY){A+=m.usdAll/YRS;B+=m.usdFlip/YRS;C+=2*m.gmxFlip/YRS;
  console.log(`| ${m.t} | $${(m.usdAll/YRS).toFixed(0)} | $${(m.usdFlip/YRS).toFixed(0)} | $${(2*m.gmxFlip/YRS).toFixed(0)} |`);}
console.log(`| ИТОГО 11 имён | $${A.toFixed(0)} | $${B.toFixed(0)} | $${C.toFixed(0)} |`);
console.log(`\nВаловая по ВСЕМУ прогону: $${(gross/YRS).toFixed(0)}/год; издержки $${(fees/YRS).toFixed(0)}/год; нетто $${((gross-fees)/YRS).toFixed(0)}/год`);
