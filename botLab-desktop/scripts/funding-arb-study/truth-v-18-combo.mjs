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
function runsOf(rows,min){const out=[];let s=0;for(let i=1;i<=rows.length;i++){const same=i<rows.length&&rows[i].f_long===rows[s].f_long&&rows[i].f_short===rows[s].f_short;if(!same){if(i-s>=min)out.push([s,i-1]);s=i;}}return out;}
function build(dropMin){ const m=new Map();
  for(const t of UNI){ const raw=all.get(t); const oim=new Map(OI[t].map(([ts,L,S])=>[ts,[L,S]]));
    let rows=raw.map(r=>{const o=oim.get(r.tsHour)||[0,0];
      return {...r,f_long:Math.sign(r.f_long)*Math.min(Math.abs(r.f_long),CAP_SEC),f_short:Math.sign(r.f_short)*Math.min(Math.abs(r.f_short),CAP_SEC),oiL:o[0],oiS:o[1]};});
    if(dropMin){ const kill=new Set(); for(const [s,e] of runsOf(raw,dropMin)) for(let i=s;i<=e;i++) kill.add(i); rows=rows.filter((_,i)=>!kill.has(i)); }
    m.set(t,rows); } return m; }
function dilute(rows,cfg,S){ const isShort=cfg==="A";
  return rows.map(r=>{const f=isShort?r.f_short:r.f_long; if(!(f>0))return r; const oi=isShort?r.oiS:r.oiL; const k=oi/(oi+S);
    return isShort?{...r,f_short:f*k}:{...r,f_long:f*k};}); }
const interp=(xs,ys,x)=>{if(x<=xs[0])return ys[0];for(let i=1;i<xs.length;i++)if(x<=xs[i]){const f=(x-xs[i-1])/(xs[i]-xs[i-1]);return ys[i-1]+f*(ys[i]-ys[i-1]);}return ys[ys.length-1]*Math.pow(x/xs[xs.length-1],0.64);};
function costUsd(t,cfg,size){const base=roundTripCost({...DEFAULT_COSTS,gmxImpact:0},size,false);const side=cfg==="A"?"short":"long";const cur=(G.interp[t]||{})[side]||[];let gbps=-1;
  if(cur.length){const xs=cur.map(p=>p.sizeUsd),ys=cur.map(p=>p.adverseBps??p.bps??0);gbps=interp(xs,ys,size);}
  const h=HL.tokens[t];return base+size*(Math.abs(gbps)/1e4)+size*((interp(XS,h.raw.buy.bps,size)+interp(XS,h.raw.sell.bps,size))/1e4);}
function bottleneck(t,cfg,share){const r=CAPD.get(t);const avail=cfg==="A"?r.availShort:r.availLong;
  const v=(VOL[t]||[]).map(c=>c.ntl).filter(Number.isFinite).sort((a,b)=>a-b);return Math.min(avail,(v.length?v[Math.floor(v.length/2)]:0)*share);}
const W=90,H=30,trainH=W*H1,holdH=H*H1, ref=all.get("BTC");
function run({SRC,capital,N=3,K=8,share=0.01,margin=5,prorata}){
  let gross=0,fees=0,per=0,held=new Map();
  for(let i=trainH;i+24<=YEAR;i+=holdH){const te=Math.min(YEAR,i+holdH);if(te-i<24)break;
    const T0=ref[i-trainH].tsHour,T1=ref[i].tsHour,T2=ref[te-1].tsHour+3600;
    const cand=[];
    for(const t of UNI){const rows=SRC.get(t);const train=rows.filter(r=>r.tsHour>=T0&&r.tsHour<T1);if(train.length<24)continue;
      const sc=scanTwoLeg(train,{token:t});if(!sc)continue;const b=sc.chosen==="A"?sc.A:sc.B;if(!(b.netMedian>0))continue;
      cand.push({t,cfg:sc.chosen,v:b.netMedian,b:bottleneck(t,sc.chosen,share)});}
    cand.sort((x,y)=>y.v-x.v);
    let left=capital;const now=new Map();
    for(const s of cand){if(now.size>=K||left<=1)break;
      const size=Math.min(capital/N,s.b/margin,left);if(size<capital/100)continue;
      let w=SRC.get(s.t).filter(r=>r.tsHour>=T1&&r.tsHour<T2);if(!w.length)continue;
      if(prorata)w=dilute(w,s.cfg,size);
      const p=openPosition({strategy:"two",instrumentKey:s.t,config:s.cfg,capital:size,leverage:1,nowMs:T1*1000,roundTripCost:0});
      accrueFromRows(p,w,T2*1000);closePosition(p,T2*1000);gross+=positionSummary(p).grossPnl;
      now.set(s.t+s.cfg,{size,t:s.t,cfg:s.cfg});left-=size;}
    for(const [k,o] of now){const prev=held.get(k);if(!prev||prev.size!==o.size)fees+=costUsd(o.t,o.cfg,o.size);}
    held=now;per++;}
  const yrs=(YEAR-trainH)/8760,net=gross-fees;return{apr:net/capital/yrs,usd:net/yrs};}
const BASE=build(0), D6=build(6);
console.log("# 28 ЧИСТЫХ ИМЁН: чем ниже строка, тем меньше допущений в свою пользу\n");
console.log("| капитал | доля HL | как в прогоне | -замороженные часы | -доля потока | -и то и другое |");
console.log("|---|---|---|---|---|---|");
for(const share of [0.005,0.01,0.02]) for(const capital of [100000,300000,1000000]){
  const a=run({SRC:BASE,capital,share,prorata:false}), b=run({SRC:D6,capital,share,prorata:false});
  const c=run({SRC:BASE,capital,share,prorata:true}), d=run({SRC:D6,capital,share,prorata:true});
  const f=x=>`$${x.usd.toFixed(0)}`;
  console.log(`| $${(capital/1e6).toFixed(2)}M | ${(100*share).toFixed(1)}% | ${f(a)} | ${f(b)} | ${f(c)} | ${f(d)} |`);
}
