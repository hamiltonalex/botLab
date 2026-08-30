// Аудит small.mjs: тот же прогон, но с разными множителями разбавления.
import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, openPosition, accrueFromRows, closePosition,
         positionSummary, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
const CLEAN = ["AAVE","ADA","ARB","AVAX","BNB","BTC","DOGE","DOT","ENA","ETH","FARTCOIN","GMX","HYPE",
  "LINK","LTC","PENDLE","PENGU","PEPE","SEI","SOL","SUI","S","TAO","TRX","UNI","VIRTUAL","XLM","XRP"];
const BASE=new Map();
for(const t of CLEAN){const p=`${SP}/truth-a-oi2/${t}.json`; if(!fs.existsSync(p))continue;
  const m=new Map(); for(const r of JSON.parse(fs.readFileSync(p,"utf8")).oi)
    m.set(Number(r.snapshotTimestamp),{L:Number(r.longFundingBalanceOiUsd)/1e30,S:Number(r.shortFundingBalanceOiUsd)/1e30});
  BASE.set(t,m);}
const W=90,H=30,trainH=W*H1,holdH=H*H1;
// mode: none | asis (S/(B+S), как в small.mjs) | inv (B/(B+S)) | perhour (по часам, только принимающая нога)
function run({capital,N=3,K=8,mode}){
  let gross=0,fees=0,per=0,held=new Map();
  for(let i=trainH;i+24<=YEAR;i+=holdH){
    const te=Math.min(YEAR,i+holdH); if(te-i<24)break;
    const cand=[];
    for(const t of CLEAN){const rows=all.get(t); if(!rows||rows.length!==YEAR)continue;
      const sc=scanTwoLeg(rows.slice(i-trainH,i),{token:t}); if(!sc)continue;
      const b=sc.chosen==="A"?sc.A:sc.B; if(!(b.netMedian>0))continue;
      cand.push({t,cfg:sc.chosen,v:b.netMedian,i,te});}
    cand.sort((x,y)=>y.v-x.v);
    let left=capital; const now=new Map();
    for(const s of cand.slice(0,K)){
      const size=Math.min(capital/N,left); if(size<capital/100)break;
      let rows=all.get(s.t).slice(s.i,s.te);
      const side=s.cfg==="A"?"S":"L", bm=BASE.get(s.t);
      let scale=1;
      if(mode==="perhour"&&bm){
        rows=rows.map(r=>{const o=bm.get(r.tsHour); if(!o)return r;
          const fX=s.cfg==="A"?r.f_short:r.f_long; if(!(fX>0))return r;
          const bX=o[side], pot=Math.max(Math.abs(r.f_long)*o.L,Math.abs(r.f_short)*o.S);
          const f2=pot/(bX+size);
          return s.cfg==="A"?{...r,f_short:f2}:{...r,f_long:f2};});
      } else if((mode==="asis"||mode==="inv")&&bm){
        let acc=0,n=0;
        for(const r of rows){const o=bm.get(r.tsHour); if(!o)continue; const b=Math.max(o[side],0);
          acc += mode==="asis" ? size/(b+size) : b/(b+size); n++;}
        scale=n?acc/n:1;
      }
      const p=openPosition({strategy:"two",instrumentKey:s.t,config:s.cfg,capital:size,leverage:1,
        nowMs:rows[0].tsHour*1000,roundTripCost:0});
      accrueFromRows(p,rows,rows[rows.length-1].tsHour*1000+3600000);
      closePosition(p,rows[rows.length-1].tsHour*1000+3600000);
      gross+=positionSummary(p).grossPnl*scale;
      now.set(s.t+s.cfg,size); left-=size;
    }
    for(const [k,sz] of now) if(held.get(k)!==sz) fees+=roundTripCost(DEFAULT_COSTS,sz,false);
    held=now; per++;
  }
  const yrs=(YEAR-trainH)/8760;
  return {usd:(gross-fees)/yrs, apr:(gross-fees)/capital/yrs};
}
console.log("| капитал | слот | без разбавл. | small.mjs: S/(B+S) | верный множитель B/(B+S) | почасовое разбавление (моя модель) |");
console.log("|---|---|---|---|---|---|");
for(const c of [1000,2000,5000,10000,20000,50000,100000,300000,1000000]){
  const n=run({capital:c,mode:"none"}), a=run({capital:c,mode:"asis"}),
        i=run({capital:c,mode:"inv"}), h=run({capital:c,mode:"perhour"});
  const f=(x)=>(x.usd<0?"-":"")+"$"+Math.abs(x.usd).toFixed(0)+" ("+(100*x.apr).toFixed(1)+"%)";
  console.log(`| $${c.toLocaleString("en-US")} | $${Math.round(c/3).toLocaleString("en-US")} | ${f(n)} | ${f(a)} | ${f(i)} | ${f(h)} |`);
}
