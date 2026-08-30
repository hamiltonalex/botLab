// Физический предел: получить с рынка больше, чем платящая сторона платит, нельзя.
// Ваша доля потока = S/(OI_вашей_стороны + S). Ставку ПОЛУЧЕНИЯ размываем, ставку ПЛАТЫ нет.
import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, openPosition, accrueFromRows, closePosition,
         positionSummary, DEFAULT_COSTS, roundTripCost, pc } from "./skept-cap-lib.mjs";
const G=JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`,"utf8"));
const HL=JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`,"utf8"));
const CAPD=new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8")).map(r=>[r.t,r]));
const VOL=JSON.parse(fs.readFileSync(`${SP}/vol63.json`,"utf8"));
const OI=JSON.parse(fs.readFileSync(`${SP}/truth-v-oi.json`,"utf8"));
const XS=HL.meta.xs, CAP_SEC=1e-7;
const UNI="AAVE ADA ARB AVAX BNB BTC DOGE DOT ENA ETH FARTCOIN GMX HYPE LINK LTC PENDLE PENGU PEPE SEI SOL SUI S TAO TRX UNI VIRTUAL XLM XRP".split(" ");
// строки с потолком 1e-7 плюс приклеенный OI
const SRC=new Map();
for(const t of UNI){ const m=new Map(OI[t].map(([ts,L,S])=>[ts,[L,S]]));
  SRC.set(t, all.get(t).map(r=>{ const o=m.get(r.tsHour)||[0,0];
    return {...r, f_long:Math.sign(r.f_long)*Math.min(Math.abs(r.f_long),CAP_SEC),
                  f_short:Math.sign(r.f_short)*Math.min(Math.abs(r.f_short),CAP_SEC), oiL:o[0], oiS:o[1]}; })); }
// разбавление: cfg A = ШОРТ GMX (наша сторона short), B = ЛОНГ GMX
function dilute(rows,cfg,S){ const isShort=cfg==="A";
  return rows.map(r=>{ const f=isShort?r.f_short:r.f_long; if(!(f>0)) return r;   // платим - не трогаем
    const oi=isShort?r.oiS:r.oiL; const k=oi/(oi+S);
    return isShort?{...r,f_short:f*k}:{...r,f_long:f*k}; }); }
const interp=(xs,ys,x)=>{ if(x<=xs[0])return ys[0];
  for(let i=1;i<xs.length;i++) if(x<=xs[i]){const f=(x-xs[i-1])/(xs[i]-xs[i-1]);return ys[i-1]+f*(ys[i]-ys[i-1]);}
  return ys[ys.length-1]*Math.pow(x/xs[xs.length-1],0.64); };
function costUsd(t,cfg,size){ const base=roundTripCost({...DEFAULT_COSTS,gmxImpact:0},size,false);
  const side=cfg==="A"?"short":"long"; const cur=(G.interp[t]||{})[side]||[]; let gbps=-1;
  if(cur.length){const xs=cur.map(p=>p.sizeUsd),ys=cur.map(p=>p.adverseBps??p.bps??0);gbps=interp(xs,ys,size);}
  const h=HL.tokens[t]; return base+size*(Math.abs(gbps)/1e4)+size*((interp(XS,h.raw.buy.bps,size)+interp(XS,h.raw.sell.bps,size))/1e4); }
function bottleneck(t,cfg,share){ const r=CAPD.get(t); const avail=cfg==="A"?r.availShort:r.availLong;
  const v=(VOL[t]||[]).map(c=>c.ntl).filter(Number.isFinite).sort((a,b)=>a-b);
  return Math.min(avail,(v.length?v[Math.floor(v.length/2)]:0)*share); }
const W=90,H=30,trainH=W*H1,holdH=H*H1;
function run({capital,N=3,K=8,share=0.01,margin=5,prorata}){
  let gross=0,fees=0,per=0,held=new Map(); const names=new Set();
  for(let i=trainH;i+24<=YEAR;i+=holdH){ const te=Math.min(YEAR,i+holdH); if(te-i<24)break;
    const cand=[];
    for(const t of UNI){ const rows=SRC.get(t); const sc=scanTwoLeg(rows.slice(i-trainH,i),{token:t}); if(!sc)continue;
      const b=sc.chosen==="A"?sc.A:sc.B; if(!(b.netMedian>0))continue;
      cand.push({t,cfg:sc.chosen,v:b.netMedian,b:bottleneck(t,sc.chosen,share)}); }
    cand.sort((x,y)=>y.v-x.v);
    let left=capital; const now=new Map();
    for(const s of cand){ if(now.size>=K||left<=1)break;
      const size=Math.min(capital/N,s.b/margin,left); if(size<capital/100)continue;
      const rows=SRC.get(s.t); let w=rows.slice(i,te);
      if(prorata) w=dilute(w,s.cfg,size);
      const p=openPosition({strategy:"two",instrumentKey:s.t,config:s.cfg,capital:size,leverage:1,nowMs:w[0].tsHour*1000,roundTripCost:0});
      accrueFromRows(p,w,w[w.length-1].tsHour*1000+3600000); closePosition(p,w[w.length-1].tsHour*1000+3600000);
      gross+=positionSummary(p).grossPnl; names.add(s.t);
      now.set(s.t+s.cfg,{size,t:s.t,cfg:s.cfg}); left-=size; }
    for(const [k,o] of now){ const prev=held.get(k); if(!prev||prev.size!==o.size) fees+=costUsd(o.t,o.cfg,o.size); }
    held=now; per++; }
  const yrs=(YEAR-trainH)/8760, net=gross-fees;
  return {apr:net/capital/yrs,usd:net/yrs,names:names.size,gross:gross/yrs,fees:fees/yrs}; }
console.log("# ФИЗИЧЕСКИЙ ПРЕДЕЛ: доля потока фандинга вместо котируемой ставки (28 чистых имён)\n");
for(const share of [0.005,0.01,0.02]){
  console.log(`## доля суточного оборота HL: ${(100*share).toFixed(1)}%`);
  console.log("| капитал | как в прогоне $/год | с долей потока $/год | что осталось |");
  console.log("|---|---|---|---|");
  for(const capital of [100000,300000,1000000,3000000]){
    const a=run({capital,share,prorata:false}), b=run({capital,share,prorata:true});
    console.log(`| $${(capital/1e6).toFixed(2)}M | ${pc(a.apr)} / $${a.usd.toFixed(0)} | ${pc(b.apr)} / $${b.usd.toFixed(0)} | ${a.usd>0?(100*b.usd/a.usd).toFixed(0)+"%":"-"} |`);
  }
  console.log("");
}
