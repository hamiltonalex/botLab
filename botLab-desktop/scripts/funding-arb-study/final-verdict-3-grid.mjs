import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, openPosition, accrueFromRows, closePosition,
         positionSummary, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
const G=JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`,"utf8"));
const HL=JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`,"utf8"));
const CAPD=new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8")).map(r=>[r.t,r]));
const VOL=JSON.parse(fs.readFileSync(`${SP}/vol63.json`,"utf8"));
const XS=HL.meta.xs, CAP_SEC=1e-7, E30=1e30, MIN_SEC=3.1710e-10;
const UNI="AAVE ADA ARB AVAX BNB BTC DOGE DOT ENA ETH FARTCOIN GMX HYPE LINK LTC PENDLE PENGU PEPE SEI SOL SUI S TAO TRX UNI VIRTUAL XLM XRP".split(" ");
function runsOf(rows,min){const out=[];let s=0;for(let i=1;i<=rows.length;i++){const same=i<rows.length&&rows[i].f_long===rows[s].f_long&&rows[i].f_short===rows[s].f_short;if(!same){if(i-s>=min)out.push([s,i-1]);s=i;}}return out;}
function build(dropMin){ const m=new Map();
  for(const t of UNI){ const raw=all.get(t);
    const oi=JSON.parse(fs.readFileSync(`truth-a-oi2/${t}.json`,"utf8")).oi;
    const om=new Map(); for(const o of oi) om.set(o.snapshotTimestamp,o);
    let rows=raw.map(r=>{const o=om.get(r.tsHour);
      const bl=o?Number(o.longFundingBalanceOiUsd)/E30:0, bs=o?Number(o.shortFundingBalanceOiUsd)/E30:0;
      return {...r,f_long:Math.sign(r.f_long)*Math.min(Math.abs(r.f_long),CAP_SEC),
                   f_short:Math.sign(r.f_short)*Math.min(Math.abs(r.f_short),CAP_SEC), bl, bs};});
    if(dropMin){ const kill=new Set(); for(const [s,e] of runsOf(raw,dropMin)) for(let i=s;i<=e;i++) kill.add(i); rows=rows.filter((_,i)=>!kill.has(i)); }
    m.set(t,rows); } return m; }
let ST=null;
function transform(rows,cfg,S,mode){ if(mode==="raw") return rows; const isShort=cfg==="A";
  return rows.map(r=>{ const f=isShort?r.f_short:r.f_long; if(!(f>0)) return r;
    const ours=isShort?r.bs:r.bl, opp=isShort?r.bl:r.bs;
    if(!(ours>0&&opp>0)) return r;
    const already = ours>opp, crossed = !already && ours+S>opp;
    if(ST){ST.h++; if(already)ST.already++; if(crossed)ST.crossed++;}
    const doFlip = (mode==="entryLo"||mode==="entryHi") ? crossed
                 : (mode==="allLo"||mode==="allHi") ? (already||crossed) : false;
    if(doFlip){ const pay = mode.endsWith("Lo") ? MIN_SEC : Math.abs(isShort?r.f_long:r.f_short);
      return isShort?{...r,f_short:-pay}:{...r,f_long:-pay}; }
    const k=ours/(ours+S);
    return isShort?{...r,f_short:f*k}:{...r,f_long:f*k}; }); }
const interp=(xs,ys,x)=>{if(x<=xs[0])return ys[0];for(let i=1;i<xs.length;i++)if(x<=xs[i]){const f=(x-xs[i-1])/(xs[i]-xs[i-1]);return ys[i-1]+f*(ys[i]-ys[i-1]);}return ys[ys.length-1]*Math.pow(x/xs[xs.length-1],0.64);};
function costUsd(t,cfg,size){const base=roundTripCost({...DEFAULT_COSTS,gmxImpact:0},size,false);const side=cfg==="A"?"short":"long";const cur=(G.interp[t]||{})[side]||[];let gbps=-1;
  if(cur.length){const xs=cur.map(p=>p.sizeUsd),ys=cur.map(p=>p.adverseBps??p.bps??0);gbps=interp(xs,ys,size);}
  const h=HL.tokens[t];return base+size*(Math.abs(gbps)/1e4)+size*((interp(XS,h.raw.buy.bps,size)+interp(XS,h.raw.sell.bps,size))/1e4);}
function bottleneck(t,cfg,share){const r=CAPD.get(t);const avail=cfg==="A"?r.availShort:r.availLong;
  const v=(VOL[t]||[]).map(c=>c.ntl).filter(Number.isFinite).sort((a,b)=>a-b);return Math.min(avail,(v.length?v[Math.floor(v.length/2)]:0)*share);}
const W=90,H=30,trainH=W*H1,holdH=H*H1, ref=all.get("BTC");
function run({SRC,capital,N=3,K=8,share=0.01,margin=5,mode}){
  let gross=0,fees=0,per=0,held=new Map(), sizes=[];
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
      w=transform(w,s.cfg,size,mode); sizes.push(size);
      const p=openPosition({strategy:"two",instrumentKey:s.t,config:s.cfg,capital:size,leverage:1,nowMs:T1*1000,roundTripCost:0});
      accrueFromRows(p,w,T2*1000);closePosition(p,T2*1000);gross+=positionSummary(p).grossPnl;
      now.set(s.t+s.cfg,{size,t:s.t,cfg:s.cfg});left-=size;}
    for(const [k,o] of now){const prev=held.get(k);if(!prev||prev.size!==o.size)fees+=costUsd(o.t,o.cfg,o.size);}
    held=now;per++;}
  const yrs=(YEAR-trainH)/8760,net=gross-fees;
  sizes.sort((a,b)=>a-b);
  return{apr:net/capital/yrs,usd:net/yrs, medSize: sizes.length?sizes[Math.floor(sizes.length/2)]:0};}
const BASE=build(0), D6=build(6);
console.log("# 28 ЧИСТЫХ ИМЁН. Чем правее столбец, тем меньше допущений в свою пользу.");
console.log("# заморозки = серии >=6ч побитово равных ставок выброшены.");
console.log("# доля потока = наш доход есть N/(база+N) от потока плательщиков (тождество GMX).");
console.log("# +знак = если НАШ ВХОД перевёл нашу сторону в большую, дальше мы платим; lo = по минимуму протокола 1%/год, hi = по ставке плательщика того часа.\n");
console.log("| капитал | доля HL | как в прогоне | -заморозки | -доля потока | -поток+знак lo | -поток+знак hi | -всё, знак lo | -всё, знак hi |");
console.log("|---|---|---|---|---|---|---|---|---|");
const best={}; const rows=[];
for(const share of [0.005,0.01,0.02]) for(const capital of [50000,100000,200000,300000,500000,1000000]){
  const f=x=>`$${Math.round(x.usd)}`;
  const a=run({SRC:BASE,capital,share,mode:"raw"});
  const b=run({SRC:D6,capital,share,mode:"raw"});
  ST={h:0,already:0,crossed:0};
  const c=run({SRC:BASE,capital,share,mode:"dil"});
  const st={...ST}; ST=null;
  const d=run({SRC:BASE,capital,share,mode:"entryLo"});
  const e=run({SRC:BASE,capital,share,mode:"entryHi"});
  const g=run({SRC:D6,capital,share,mode:"entryLo"});
  const h=run({SRC:D6,capital,share,mode:"entryHi"});
  console.log(`| $${(capital/1e6).toFixed(2)}M | ${(100*share).toFixed(1)}% | ${f(a)} | ${f(b)} | ${f(c)} | ${f(d)} | ${f(e)} | ${f(g)} | ${f(h)} |`);
  rows.push({capital,share,st,med:c.medSize});
  for(const [n,v] of [["как в прогоне",a],["-заморозки",b],["-доля потока",c],["-всё, знак lo",g],["-всё, знак hi",h]])
    if(!best[n]||v.usd>best[n].usd) best[n]={usd:v.usd,capital,share};
}
console.log("\n# ЛУЧШАЯ КЛЕТКА СЕТКИ (порог заказчика $25000-30000 в год)");
for(const [n,v] of Object.entries(best)) console.log(`  ${n}: $${Math.round(v.usd)} при $${(v.capital/1e6).toFixed(2)}M, доля HL ${(100*v.share).toFixed(1)}%`);
console.log("\n# ЧАСЫ-ПОЛУЧАТЕЛЯ: где мы УЖЕ большая сторона (инерция GMX) и где нас туда переводит ВХОД");
console.log("| капитал | доля HL | медианный размер позиции | часов | уже большая сторона | переведены входом |");
console.log("|---|---|---|---|---|---|");
for(const r of rows) console.log(`| $${(r.capital/1e6).toFixed(2)}M | ${(100*r.share).toFixed(1)}% | $${Math.round(r.med)} | ${r.st.h} | ${(100*r.st.already/r.st.h).toFixed(2)}% | ${(100*r.st.crossed/r.st.h).toFixed(2)}% |`);
