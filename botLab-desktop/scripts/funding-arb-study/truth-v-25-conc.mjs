// где именно в 28 чистых сидит выживший результат и как он зависит от заморозок
import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, openPosition, accrueFromRows, closePosition,
         positionSummary, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
const G=JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`,"utf8")), HL=JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`,"utf8"));
const CAPD=new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8")).map(r=>[r.t,r]));
const VOL=JSON.parse(fs.readFileSync(`${SP}/vol63.json`,"utf8")), OI=JSON.parse(fs.readFileSync(`${SP}/truth-v-oi.json`,"utf8"));
const XS=HL.meta.xs, CAP_SEC=1e-7;
const UNI="AAVE ADA ARB AVAX BNB BTC DOGE DOT ENA ETH FARTCOIN GMX HYPE LINK LTC PENDLE PENGU PEPE SEI SOL SUI S TAO TRX UNI VIRTUAL XLM XRP".split(" ");
function runsOf(rows,min){const o=[];let s=0;for(let i=1;i<=rows.length;i++){const q=i<rows.length&&rows[i].f_long===rows[s].f_long&&rows[i].f_short===rows[s].f_short;if(!q){if(i-s>=min)o.push([s,i-1]);s=i;}}return o;}
const FR=new Map(UNI.map(t=>{const s=new Set();for(const [a,b] of runsOf(all.get(t),6))for(let i=a;i<=b;i++)s.add(all.get(t)[i].tsHour);return [t,s];}));
const SRC=new Map(UNI.map(t=>[t,all.get(t).map(r=>({...r,f_long:Math.sign(r.f_long)*Math.min(Math.abs(r.f_long),CAP_SEC),f_short:Math.sign(r.f_short)*Math.min(Math.abs(r.f_short),CAP_SEC)}))]));
const interp=(xs,ys,x)=>{if(x<=xs[0])return ys[0];for(let i=1;i<xs.length;i++)if(x<=xs[i]){const f=(x-xs[i-1])/(xs[i]-xs[i-1]);return ys[i-1]+f*(ys[i]-ys[i-1]);}return ys[ys.length-1]*Math.pow(x/xs[xs.length-1],0.64);};
function costUsd(t,cfg,size){const base=roundTripCost({...DEFAULT_COSTS,gmxImpact:0},size,false);const side=cfg==="A"?"short":"long";const cur=(G.interp[t]||{})[side]||[];let g=-1;
 if(cur.length)g=interp(cur.map(p=>p.sizeUsd),cur.map(p=>p.adverseBps??p.bps??0),size);
 const h=HL.tokens[t];return base+size*(Math.abs(g)/1e4)+size*((interp(XS,h.raw.buy.bps,size)+interp(XS,h.raw.sell.bps,size))/1e4);}
function bn(t,cfg,share){const r=CAPD.get(t);const a=cfg==="A"?r.availShort:r.availLong;const v=(VOL[t]||[]).map(c=>c.ntl).filter(Number.isFinite).sort((x,y)=>x-y);return Math.min(a,(v.length?v[Math.floor(v.length/2)]:0)*share);}
const W=90,H=30,trainH=W*H1,holdH=H*H1;
const capital=300000, share=0.02;
let byT=new Map(), grossFroz=0, grossFresh=0, held=new Map(), fees=0;
for(let i=trainH;i+24<=YEAR;i+=holdH){const te=Math.min(YEAR,i+holdH);if(te-i<24)break;
 const cand=[];
 for(const t of UNI){const rows=SRC.get(t);const sc=scanTwoLeg(rows.slice(i-trainH,i),{token:t});if(!sc)continue;
  const b=sc.chosen==="A"?sc.A:sc.B;if(!(b.netMedian>0))continue;cand.push({t,cfg:sc.chosen,v:b.netMedian,b:bn(t,sc.chosen,share)});}
 cand.sort((x,y)=>y.v-x.v);let left=capital;const now=new Map();
 for(const s of cand){if(now.size>=8||left<=1)break;const size=Math.min(capital/3,s.b/5,left);if(size<capital/100)continue;
  const w=SRC.get(s.t).slice(i,te);
  // раздельно: часы внутри заморозок и вне
  for(const part of ["froz","fresh"]){
    const sub=w.filter(r=>(FR.get(s.t).has(r.tsHour))===(part==="froz")); if(!sub.length)continue;
    const p=openPosition({strategy:"two",instrumentKey:s.t,config:s.cfg,capital:size,leverage:1,nowMs:sub[0].tsHour*1000,roundTripCost:0});
    accrueFromRows(p,sub,sub[sub.length-1].tsHour*1000+3600000);closePosition(p,sub[sub.length-1].tsHour*1000+3600000);
    const g=positionSummary(p).grossPnl; if(part==="froz")grossFroz+=g;else grossFresh+=g;
    byT.set(s.t,(byT.get(s.t)||0)+g);}
  now.set(s.t+s.cfg,{size,t:s.t,cfg:s.cfg});left-=size;}
 for(const [k,o] of now){const pv=held.get(k);if(!pv||pv.size!==o.size)fees+=costUsd(o.t,o.cfg,o.size);}
 held=now;}
const yrs=(YEAR-trainH)/8760;
console.log(`# ГДЕ СИДИТ ВЫЖИВШИЙ РЕЗУЛЬТАТ (28 чистых, $300k, доля HL 2%)`);
console.log(`брутто из часов ВНУТРИ заморозок >=6ч: $${(grossFroz/yrs).toFixed(0)}/год`);
console.log(`брутто из ОСТАЛЬНЫХ часов:            $${(grossFresh/yrs).toFixed(0)}/год`);
console.log(`доля заморозок в брутто: ${(100*grossFroz/(grossFroz+grossFresh)).toFixed(1)}%`);
console.log(`издержки: $${(fees/yrs).toFixed(0)}/год, нетто $${((grossFroz+grossFresh-fees)/yrs).toFixed(0)}/год`);
console.log(`\nвклад имён в брутто, $/год:`);
for(const [t,g] of [...byT].sort((a,b)=>b[1]-a[1])) console.log(`  ${t.padEnd(9)} $${(g/yrs).toFixed(0)}`);
