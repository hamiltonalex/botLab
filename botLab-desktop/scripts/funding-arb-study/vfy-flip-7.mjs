// СКЕПТИК, батарея 7: (4) таблица утверждения на РЕАЛЬНЫХ размерах, (5) деньги по ВСЕМУ прогону.
import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, annualizeRow, maxOf, openPosition, accrueFromRows,
         closePosition, positionSummary, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
const cap63=JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8"));
const CAP=new Map(cap63.map(r=>[r.t,r]));
const VOL=JSON.parse(fs.readFileSync(`${SP}/vol63.json`,"utf8"));
const med=xs=>{const a=xs.slice().sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):NaN;};
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
function doRun({capital=300000,N=3,K,share,margin,sane=10}){
  const HOLD=[];let gross=0,fees=0,held=new Map();
  for(let pi=0;pi<TAB.length;pi++){const m=TAB[pi];const [i,te]=PER[pi];
    const cand=[...m.entries()].filter(([,d])=>Number.isFinite(d.peak)&&d.peak<=sane)
      .map(([t,d])=>({t,...d,b:bottleneck(t,d.cfg,d.hlTrail,share)})).sort((a,b)=>b.v-a.v);
    let left=capital;const now=new Map();
    for(const s of cand){if(now.size>=K||left<=1)break;
      const size=Math.min(capital/N,s.b/margin,left);if(size<capital/100)continue;
      now.set(s.t+s.cfg,size);left-=size;gross+=s.g1*size;HOLD.push({t:s.t,cfg:s.cfg,size,i,te});}
    for(const [k,sz] of now) if(held.get(k)!==sz)fees+=roundTripCost(DEFAULT_COSTS,sz,false);
    held=now;}
  return {HOLD,gross,fees,net:gross-fees};
}
const OI=new Map();
for(const f of fs.readdirSync(`${SP}/truth-a-oi2`)) if(f.endsWith(".json")){
  const t=f.replace(".json","");
  OI.set(t,new Map(JSON.parse(fs.readFileSync(`${SP}/truth-a-oi2/${f}`,"utf8")).oi.map(r=>[r.snapshotTimestamp,r])));}

// ---- (4) ТАБЛИЦА УТВЕРЖДЕНИЯ, ПЕРЕСЧИТАННАЯ НА ЗАЯВЛЕННЫХ РЕАЛЬНЫХ РАЗМЕРАХ ----
const REAL={PENGU:20581,BNB:36621,DOT:4992,PEPE:11903,SEI:3612,TAO:20174,TRX:5064,VIRTUAL:5071,LINK:31123,XRP:100000,ADA:4400};
const CFG={PENGU:"A",BNB:"B",DOT:"A",PEPE:"B",SEI:"A",TAO:"A",TRX:"A",VIRTUAL:"A",LINK:"A",XRP:"A",ADA:"A"};
console.log("== 4. ПЕРЕСЧЁТ ТАБЛИЦЫ НА РЕАЛЬНЫХ РАЗМЕРАХ (все 8761 час, сторона = конфиг прогона) ==");
console.log("| рынок | конфиг | реальный размер | утв.: $100k переворачивает | наша сторона УЖЕ больше | реальный размер ПЕРЕворачивает | наша сторона больше ПОСЛЕ добавки |");
console.log("|---|---|---|---|---|---|---|");
for(const t of Object.keys(REAL)){
  const oim=OI.get(t);let tot=0,already=0,fr=0,f100=0;
  for(const [,o] of oim){const L=+o.longFundingBalanceOiUsd/1e30,S=+o.shortFundingBalanceOiUsd/1e30;
    if(!(L>0&&S>0))continue;tot++;
    const our=CFG[t]==="A"?S:L, opp=CFG[t]==="A"?L:S;
    if(our>=opp){already++;f100++;fr++;}
    else{if(1e5>opp-our)f100++; if(REAL[t]>opp-our)fr++;}}
  console.log(`| ${t} | ${CFG[t]} | $${REAL[t]} | ${(100*f100/tot).toFixed(1)}% | ${(100*already/tot).toFixed(1)}% | ${(100*(fr-already)/tot).toFixed(1)}% | ${(100*fr/tot).toFixed(1)}% |`);
}

// ---- (5) ДЕНЬГИ ПО ВСЕМУ ПРОГОНУ, все удерживаемые имена ----
console.log("\n== 5. ДЕНЬГИ ПО ВСЕМУ ПРОГОНУ ==");
for(const cell of [{K:8,share:0.01,margin:5,lbl:"базовая ячейка (K=8, 1% HL, запас 5x)"},
                   {K:25,share:0.02,margin:2,lbl:"лучшая ячейка (K=25, 2% HL, запас 2x)"}]){
  const R=doRun(cell);
  let gAll=0,gFlipNet=0,gFlipGmx=0,hTot=0,hFlip=0,hAlready=0,noOi=0;
  for(const p of R.HOLD){const rows=all.get(p.t);const oim=OI.get(p.t);if(!oim){noOi++;continue;}
    for(let k=p.i;k<p.te;k++){const r=rows[k];const o=oim.get(r.tsHour);if(!o)continue;
      const L=+o.longFundingBalanceOiUsd/1e30,S=+o.shortFundingBalanceOiUsd/1e30;if(!(L>0&&S>0))continue;
      const our=p.cfg==="A"?S:L, opp=p.cfg==="A"?L:S;
      const a=annualizeRow(r);const net=p.cfg==="A"?a.net_A:a.net_B;
      const gmx=p.cfg==="A"?a.gmx_short_recv:a.gmx_long_recv;
      hTot++;gAll+=p.size*net/8760;
      const bigAfter = our>=opp || p.size>opp-our;
      if(our>=opp)hAlready++;
      if(bigAfter){hFlip++;gFlipNet+=p.size*net/8760;gFlipGmx+=p.size*gmx/8760;}}}
  console.log(`\n### ${cell.lbl}`);
  console.log(`  нетто прогона                     $${(R.net/YRS).toFixed(0)}/год  (валовая $${(R.gross/YRS).toFixed(0)}, издержки $${(R.fees/YRS).toFixed(0)})`);
  console.log(`  часов удержания с данными OI      ${hTot}`);
  console.log(`  из них наша сторона УЖЕ больше    ${(100*hAlready/hTot).toFixed(1)}%`);
  console.log(`  наша сторона больше ПОСЛЕ добавки ${(100*hFlip/hTot).toFixed(1)}%`);
  console.log(`  валовая, сидящая в таких часах    $${(gFlipNet/YRS).toFixed(0)}/год`);
  console.log(`  нога GMX в таких часах            $${(gFlipGmx/YRS).toFixed(0)}/год`);
  console.log(`  сценарий «ставка обнулилась»      нетто -> $${((R.net-gFlipGmx)/YRS).toFixed(0)}/год`);
  console.log(`  сценарий «знак развернулся»       нетто -> $${((R.net-2*gFlipGmx)/YRS).toFixed(0)}/год`);
}
