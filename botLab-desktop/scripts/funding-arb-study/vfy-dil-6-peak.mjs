import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, openPosition, accrueFromRows, closePosition,
         DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
const CLEAN=["AAVE","ADA","ARB","AVAX","BNB","BTC","DOGE","DOT","ENA","ETH","FARTCOIN","GMX","HYPE",
 "LINK","LTC","PENDLE","PENGU","PEPE","SEI","SOL","SUI","S","TAO","TRX","UNI","VIRTUAL","XLM","XRP"];
const BASE=new Map();
for(const t of CLEAN){const m=new Map();
 for(const r of JSON.parse(fs.readFileSync(`${SP}/truth-a-oi2/${t}.json`,"utf8")).oi)
  m.set(Number(r.snapshotTimestamp),{L:Number(r.longFundingBalanceOiUsd)/1e30,S:Number(r.shortFundingBalanceOiUsd)/1e30});
 BASE.set(t,m);}
const W=90,H=30,trainH=W*H1,holdH=H*H1,yrs=(YEAR-trainH)/8760;
const P=[];
for(let i=trainH;i+24<=YEAR;i+=holdH){const te=Math.min(YEAR,i+holdH);if(te-i<24)break;const c=[];
 for(const t of CLEAN){const rows=all.get(t);if(!rows||rows.length!==YEAR)continue;
  const sc=scanTwoLeg(rows.slice(i-trainH,i),{token:t});if(!sc)continue;const b=sc.chosen==="A"?sc.A:sc.B;
  if(!(b.netMedian>0))continue;c.push({t,cfg:sc.chosen,v:b.netMedian,i,te});}
 c.sort((x,y)=>y.v-x.v);P.push(c.slice(0,3));}
const cap63=JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8"));const room=new Map(cap63.map(r=>[r.t,r]));
console.log("капитал | слот | нетто $/год (разбавление) | APR | слот/ёмкость мин. имени");
for(const cap of [1000,2000,3000,5000,8000,12000,16000,20000,25000,30000,40000,60000]){
 const size=cap/3;let g=0,fees=0,held=new Map(),worst=0;
 for(const per of P){const now=new Map();
  for(const s of per){const rows=all.get(s.t).slice(s.i,s.te);const side=s.cfg==="A"?"S":"L";const bm=BASE.get(s.t);
   const c=room.get(s.t);const rm=c?(s.cfg==="A"?c.availShort:c.availLong):NaN;
   if(Number.isFinite(rm)) worst=Math.max(worst,size/rm);
   const p=openPosition({strategy:"two",instrumentKey:s.t,config:s.cfg,capital:size,leverage:1,nowMs:rows[0].tsHour*1000,roundTripCost:0});
   accrueFromRows(p,rows,rows[rows.length-1].tsHour*1000+3600000);closePosition(p,rows[rows.length-1].tsHour*1000+3600000);
   for(const a of p.accruals){const h=Math.floor((a.t-a.dtSec*1000)/1000/3600)*3600;const o=bm.get(h);
    let f=a.fundingUsd||0;if(o&&f>0){const b=Math.max(o[side],0);f*=b/(b+size);}
    g+=f+(a.borrowUsd||0)+(a.dPnlHl||0);}
   now.set(s.t+s.cfg,size);}
  for(const [k,sz] of now) if(held.get(k)!==sz) fees+=roundTripCost(DEFAULT_COSTS,sz,false);
  held=now;}
 const net=(g-fees)/yrs;
 console.log(`$${cap} | $${size.toFixed(0)} | ${net.toFixed(0)} | ${(100*net/cap).toFixed(2)}% | ${(100*worst).toFixed(0)}%`);}
