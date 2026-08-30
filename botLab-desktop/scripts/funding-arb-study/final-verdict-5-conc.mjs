import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, openPosition, accrueFromRows, closePosition,
         positionSummary, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
const G=JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`,"utf8"));
const HL=JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`,"utf8"));
const CAPD=new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8")).map(r=>[r.t,r]));
const VOL=JSON.parse(fs.readFileSync(`${SP}/vol63.json`,"utf8"));
const XS=HL.meta.xs, CAP_SEC=1e-7, E30=1e30;
const UNI="AAVE ADA ARB AVAX BNB BTC DOGE DOT ENA ETH FARTCOIN GMX HYPE LINK LTC PENDLE PENGU PEPE SEI SOL SUI S TAO TRX UNI VIRTUAL XLM XRP".split(" ");
const SRC=new Map();
for(const t of UNI){ const raw=all.get(t);
  const oi=JSON.parse(fs.readFileSync(`truth-a-oi2/${t}.json`,"utf8")).oi;
  const om=new Map(); for(const o of oi) om.set(o.snapshotTimestamp,o);
  SRC.set(t, raw.map(r=>{const o=om.get(r.tsHour);
    return {...r,f_long:Math.sign(r.f_long)*Math.min(Math.abs(r.f_long),CAP_SEC),
                 f_short:Math.sign(r.f_short)*Math.min(Math.abs(r.f_short),CAP_SEC),
                 bl:o?Number(o.longFundingBalanceOiUsd)/E30:0, bs:o?Number(o.shortFundingBalanceOiUsd)/E30:0};}));}
const interp=(xs,ys,x)=>{if(x<=xs[0])return ys[0];for(let i=1;i<xs.length;i++)if(x<=xs[i]){const f=(x-xs[i-1])/(xs[i]-xs[i-1]);return ys[i-1]+f*(ys[i]-ys[i-1]);}return ys[ys.length-1]*Math.pow(x/xs[xs.length-1],0.64);};
function costUsd(t,cfg,size){const base=roundTripCost({...DEFAULT_COSTS,gmxImpact:0},size,false);const side=cfg==="A"?"short":"long";const cur=(G.interp[t]||{})[side]||[];let gbps=-1;
  if(cur.length){const xs=cur.map(p=>p.sizeUsd),ys=cur.map(p=>p.adverseBps??p.bps??0);gbps=interp(xs,ys,size);}
  const h=HL.tokens[t];return base+size*(Math.abs(gbps)/1e4)+size*((interp(XS,h.raw.buy.bps,size)+interp(XS,h.raw.sell.bps,size))/1e4);}
function bottleneck(t,cfg,share){const r=CAPD.get(t);const avail=cfg==="A"?r.availShort:r.availLong;
  const v=(VOL[t]||[]).map(c=>c.ntl).filter(Number.isFinite).sort((a,b)=>a-b);return Math.min(avail,(v.length?v[Math.floor(v.length/2)]:0)*share);}
const trainH=90*H1, holdH=30*H1, ref=all.get("BTC");
const capital=300000, share=0.02, N=3, K=8, margin=5;
const agg=new Map();
for(let i=trainH;i+24<=YEAR;i+=holdH){const te=Math.min(YEAR,i+holdH);if(te-i<24)break;
  const T0=ref[i-trainH].tsHour,T1=ref[i].tsHour,T2=ref[te-1].tsHour+3600;
  const cand=[];
  for(const t of UNI){const rows=SRC.get(t);const train=rows.filter(r=>r.tsHour>=T0&&r.tsHour<T1);if(train.length<24)continue;
    const sc=scanTwoLeg(train,{token:t});if(!sc)continue;const b=sc.chosen==="A"?sc.A:sc.B;if(!(b.netMedian>0))continue;
    cand.push({t,cfg:sc.chosen,v:b.netMedian,b:bottleneck(t,sc.chosen,share)});}
  cand.sort((x,y)=>y.v-x.v);
  let left=capital;let n=0;
  for(const s of cand){if(n>=K||left<=1)break;
    const size=Math.min(capital/N,s.b/margin,left);if(size<capital/100)continue;
    const w=SRC.get(s.t).filter(r=>r.tsHour>=T1&&r.tsHour<T2);if(!w.length)continue;
    const p=openPosition({strategy:"two",instrumentKey:s.t,config:s.cfg,capital:size,leverage:1,nowMs:T1*1000,roundTripCost:0});
    accrueFromRows(p,w,T2*1000);closePosition(p,T2*1000);
    const g=positionSummary(p).grossPnl;
    const isShort=s.cfg==="A"; const bases=[];
    for(const r of w){const f=isShort?r.f_short:r.f_long; if(f>0) bases.push(isShort?r.bs:r.bl);}
    bases.sort((a,b)=>a-b);
    const a=agg.get(s.t)||{g:0,fees:0,h:0,sz:[],bases:[]};
    a.g+=g; a.fees+=costUsd(s.t,s.cfg,size); a.h+=w.length; a.sz.push(size); a.bases.push(...bases); agg.set(s.t,a);
    left-=size; n++;}
}
const yrs=(YEAR-trainH)/8760;
const list=[...agg].map(([t,a])=>{a.bases.sort((x,y)=>x-y);a.sz.sort((x,y)=>x-y);
  return {t, net:(a.g-a.fees)/yrs, gross:a.g/yrs, medSize:a.sz[Math.floor(a.sz.length/2)],
    medBase:a.bases.length?a.bases[Math.floor(a.bases.length/2)]:0};}).sort((x,y)=>y.net-x.net);
const tot=list.reduce((s,x)=>s+x.net,0);
console.log(`# КОНЦЕНТРАЦИЯ ПРИБЫЛИ, капитал $${capital}, доля HL ${(100*share)}%, чистая вселенная. Нетто за год $${Math.round(tot)}`);
console.log("| имя | нетто $/год | доля | медианный размер позиции | медианная база стороны-получателя | размер / база |");
console.log("|---|---|---|---|---|---|");
for(const x of list) console.log(`| ${x.t} | $${Math.round(x.net)} | ${(100*x.net/tot).toFixed(1)}% | $${Math.round(x.medSize).toLocaleString("ru-RU")} | $${Math.round(x.medBase).toLocaleString("ru-RU")} | ${x.medBase?(x.medSize/x.medBase).toFixed(2)+"x":"-"} |`);
