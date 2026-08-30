import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs"; import path from "node:path";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { scanTwoLeg } from "../../src/engine/math.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";
import { openPosition, accrueFromRows, closePosition, positionSummary } from "../../src/engine/paper.js";
export const SP=STUDY_DATA;
export const CACHE=STUDY_CACHE;
export const MAJORS=["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC","BCH","DOT","ATOM","ARB","OP","NEAR","SUI","TRX","UNI","AAVE","XLM","HBAR","TAO","FIL"];
export function loadY1(){const m=new Map();for(const f of fs.readdirSync(CACHE).filter(f=>f.endsWith(".csv")&&!f.startsWith("_"))){const r=parseSpreadCsv(fs.readFileSync(path.join(CACHE,f),"utf8"));m.set(f.replace(/_\d+_\d+\.csv$/,""),r);}return m;}
export function loadY2(){const m=new Map();for(const f of fs.readdirSync(`${SP}/y2`).filter(f=>f.endsWith(".csv"))){const r=parseSpreadCsv(fs.readFileSync(`${SP}/y2/${f}`,"utf8"));if(r.length)m.set(f.replace(".csv",""),r);}return m;}

// Прогон вне выборки. Правила зовутся из движка; своей арифметики начисления нет.
// ВЫРАВНИВАНИЕ ПО КАЛЕНДАРЮ: окно задаётся МЕТКОЙ ВРЕМЕНИ, а не индексом, и каждый токен
// режется по своим меткам. Так индексный сдвиг из-за разной длины истории невозможен.
export function walkCal({rowsBy,tokens,W,H,N,key="median",capital=2000}){
  const trainH=W*24, holdH=H*24, per=capital/N;
  const rt=roundTripCost(DEFAULT_COSTS,per,false);
  const hrs=tokens.map(t=>rowsBy.get(t).map(r=>r.tsHour));
  const t0=Math.max(...hrs.map(h=>h[0])), tEnd=Math.min(...hrs.map(h=>h[h.length-1]));
  const idx=new Map(tokens.map((t,k)=>[t,new Map(hrs[k].map((h,i)=>[h,i]))]));
  const seg=(t,a,b)=>rowsBy.get(t).filter(r=>r.tsHour>=a&&r.tsHour<b);
  const startTs=t0+trainH*3600;
  let gross=0,opens=0,held=new Set();
  const byPeriod=[],byToken=new Map(),perLen=[];
  for(let ts=startTs; ts+24*3600<=tEnd+3600; ts+=holdH*3600){
    const te=Math.min(tEnd+3600, ts+holdH*3600); if((te-ts)/3600<24)break;
    const cand=[];
    for(const t of tokens){
      const train=seg(t,ts-trainH*3600,ts); if(train.length<24)continue;
      const sc=scanTwoLeg(train,{token:t}); if(!sc)continue;
      const b=sc.chosen==="A"?sc.A:sc.B;
      const v=key==="median"?b.netMedian:b.netMean;
      if(Number.isFinite(v)&&v>0)cand.push({t,cfg:sc.chosen,v});
    }
    cand.sort((x,y)=>y.v-x.v);
    const sel=cand.slice(0,N);
    let pg=0,po=0;
    for(const s of sel){
      const rr=seg(s.t,ts,te); if(!rr.length)continue;
      const a=rr[0].tsHour*1000, b=rr[rr.length-1].tsHour*1000+3600000;
      const p=openPosition({strategy:"two",instrumentKey:s.t,config:s.cfg,capital:per,leverage:1,nowMs:a,roundTripCost:0});
      accrueFromRows(p,rr,b); closePosition(p,b);
      const g=positionSummary(p).grossPnl;
      gross+=g;pg+=g;byToken.set(s.t,(byToken.get(s.t)||0)+g);
      if(!held.has(s.t+s.cfg)){opens++;po++;}
    }
    held=new Set(sel.map(s=>s.t+s.cfg));
    byPeriod.push(pg-po*rt); perLen.push((te-ts)/3600);
  }
  const spanH=(tEnd+3600-startTs)/3600, yrs=spanH/8760, net=gross-opens*rt;
  return {periods:byPeriod.length,opens,gross,net,apr:net/capital/yrs,pos:byPeriod.filter(x=>x>0).length,byPeriod,perLen,byToken,yrs,
    from:new Date(startTs*1000).toISOString().slice(0,13),to:new Date((tEnd+3600)*1000).toISOString().slice(0,13)};
}
export const pc=x=>(x>=0?"+":"")+(100*x).toFixed(2)+"%";
// t-статистика и bootstrap по годовым доходностям периодов
export function stats(byPeriod,perLen,capital=2000){
  const a=byPeriod.map((v,i)=>(v/capital)*(8760/perLen[i]));
  const n=a.length,m=a.reduce((s,x)=>s+x,0)/n;
  const sd=Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(n-1));
  const se=sd/Math.sqrt(n), t=m/se;
  let B=20000,lo=[],rnd=(()=>{let s=12345;return()=>((s=(s*1103515245+12345)&0x7fffffff)/0x7fffffff);})();
  for(let b=0;b<B;b++){let sm=0;for(let i=0;i<n;i++)sm+=a[Math.floor(rnd()*n)];lo.push(sm/n);}
  lo.sort((x,y)=>x-y);
  return {n,mean:m,sd,se,t,ci:[lo[Math.floor(0.025*B)],lo[Math.floor(0.975*B)]],series:a};
}
