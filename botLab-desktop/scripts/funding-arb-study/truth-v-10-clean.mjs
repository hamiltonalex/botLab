import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, openPosition, accrueFromRows, closePosition,
         positionSummary, DEFAULT_COSTS, roundTripCost, pc } from "./skept-cap-lib.mjs";
const G = JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`, "utf8"));
const HL = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const CAP = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((r) => [r.t, r]));
const VOL = JSON.parse(fs.readFileSync(`${SP}/vol63.json`, "utf8"));
const PROT = new Map(JSON.parse(fs.readFileSync(`${SP}/truth-v-cap.json`,"utf8")).map(r=>[r.t,Number(r.maxFundingFactorPerSecondLong)/1e30]));
const XS = HL.meta.xs, CAP_SEC = 1e-7;
const UNI = "AAVE ADA ARB AVAX BNB BTC DOGE DOT ENA ETH FARTCOIN GMX HYPE LINK LTC PENDLE PENGU PEPE SEI SOL SUI S TAO TRX UNI VIRTUAL XLM XRP".split(" ");

// --- 3.1 инвентарь заморозок у 28 чистых имён ---
function runsOf(rows,min){ const out=[]; let s=0;
  for(let i=1;i<=rows.length;i++){ const same=i<rows.length&&rows[i].f_long===rows[s].f_long&&rows[i].f_short===rows[s].f_short;
    if(!same){ if(i-s>=min) out.push([s,i-1]); s=i; } } return out; }
console.log("# 3.1 ЗАМОРОЖЕННЫЕ СЕРИИ У 28 ЧИСТЫХ ИМЁН");
console.log("| имя | часов в сериях >=6ч | % года | самая длинная | значение самой длинной, % год | серий >=24ч |");
console.log("|---|---|---|---|---|---|");
let tot6=0;
for(const t of UNI){ const rows=all.get(t); const rs=runsOf(rows,6);
  const h=rs.reduce((a,[s,e])=>a+e-s+1,0); tot6+=h;
  const lg=rs.slice().sort((a,b)=>(b[1]-b[0])-(a[1]-a[0]))[0];
  const n24=runsOf(rows,24).length;
  console.log(`| ${t} | ${h} | ${(100*h/rows.length).toFixed(1)}% | ${lg?lg[1]-lg[0]+1:0}ч | ${lg?(rows[lg[0]].f_long*3600*8760*100).toFixed(1):"-"} | ${n24} |`);
}
console.log(`\nвсего часов в сериях >=6ч у 28 чистых: ${tot6} из ${28*YEAR} = ${(100*tot6/(28*YEAR)).toFixed(2)}%\n`);

// --- 3.2 прогон в четырёх видах ---
const interp=(xs,ys,x)=>{ if(x<=xs[0])return ys[0];
  for(let i=1;i<xs.length;i++) if(x<=xs[i]){const f=(x-xs[i-1])/(xs[i]-xs[i-1]);return ys[i-1]+f*(ys[i]-ys[i-1]);}
  return ys[ys.length-1]*Math.pow(x/xs[xs.length-1],0.64); };
function costUsd(t,cfg,size){ const base=roundTripCost({...DEFAULT_COSTS,gmxImpact:0},size,false);
  const side=cfg==="A"?"short":"long"; const cur=(G.interp[t]||{})[side]||[]; let gbps=-1;
  if(cur.length){const xs=cur.map(p=>p.sizeUsd),ys=cur.map(p=>p.adverseBps??p.bps??0); gbps=interp(xs,ys,size);}
  const h=HL.tokens[t]; const hbuy=interp(XS,h.raw.buy.bps,size),hsell=interp(XS,h.raw.sell.bps,size);
  return base+size*(Math.abs(gbps)/1e4)+size*((hbuy+hsell)/1e4); }
function bottleneck(t,cfg,share){ const r=CAP.get(t); const avail=cfg==="A"?r.availShort:r.availLong;
  const v=(VOL[t]||[]).map(c=>c.ntl).filter(Number.isFinite).sort((a,b)=>a-b);
  return Math.min(avail, (v.length?v[Math.floor(v.length/2)]:0)*share); }

function build(mode){ const m=new Map();
  for(const t of UNI){ let rows=all.get(t);
    const ceil = mode==="prot" ? (PROT.get(t)??CAP_SEC) : CAP_SEC;
    let capped = rows.map(r=>({...r, f_long:Math.sign(r.f_long)*Math.min(Math.abs(r.f_long),ceil),
                                     f_short:Math.sign(r.f_short)*Math.min(Math.abs(r.f_short),ceil)}));
    if(mode==="drop6"||mode==="drop24"){ const min=mode==="drop6"?6:24;
      const kill=new Set(); for(const [s,e] of runsOf(rows,min)) for(let i=s;i<=e;i++) kill.add(i);
      capped=capped.filter((_,i)=>!kill.has(i)); }
    m.set(t,capped); }
  return m; }

const W=90,H=30,trainH=W*H1,holdH=H*H1;
function run({SRC,capital,N=3,K=8,share=0.01,margin=5}){
  // окна нарезаем по КАЛЕНДАРЮ (индексы полного года), чтобы выброс часов не сжимал время
  const ref=all.get("BTC");
  let gross=0,fees=0,utilSum=0,per=0,held=new Map(); const names=new Set();
  for(let i=trainH;i+24<=YEAR;i+=holdH){ const te=Math.min(YEAR,i+holdH); if(te-i<24)break;
    const T0=ref[i-trainH].tsHour, T1=ref[i].tsHour, T2=ref[te-1].tsHour+3600;
    const cand=[];
    for(const t of UNI){ const rows=SRC.get(t);
      const train=rows.filter(r=>r.tsHour>=T0&&r.tsHour<T1); if(train.length<24) continue;
      const sc=scanTwoLeg(train,{token:t}); if(!sc) continue;
      const b=sc.chosen==="A"?sc.A:sc.B; if(!(b.netMedian>0)) continue;
      const w=rows.filter(r=>r.tsHour>=T1&&r.tsHour<T2); if(!w.length) continue;
      const p=openPosition({strategy:"two",instrumentKey:t,config:sc.chosen,capital:1,leverage:1,nowMs:T1*1000,roundTripCost:0});
      accrueFromRows(p,w,T2*1000); closePosition(p,T2*1000);
      cand.push({t,cfg:sc.chosen,v:b.netMedian,g1:positionSummary(p).grossPnl,b:bottleneck(t,sc.chosen,share)}); }
    cand.sort((x,y)=>y.v-x.v);
    let left=capital; const now=new Map();
    for(const s of cand){ if(now.size>=K||left<=1)break;
      const size=Math.min(capital/N,s.b/margin,left); if(size<capital/100)continue;
      now.set(s.t+s.cfg,{size,t:s.t,cfg:s.cfg}); left-=size; gross+=s.g1*size; names.add(s.t); }
    for(const [k,o] of now){ const prev=held.get(k); if(!prev||prev.size!==o.size) fees+=costUsd(o.t,o.cfg,o.size); }
    utilSum+=(capital-left)/capital; held=now; per++; }
  const yrs=(YEAR-trainH)/8760, net=gross-fees;
  return {apr:net/capital/yrs,usd:net/yrs,util:utilSum/per,names:names.size,gross:gross/yrs,fees:fees/yrs}; }

const MODES=[["БАЗА (потолок 1e-7, часы на месте)","cap"],["ВЫКИНУТЫ серии >=6ч","drop6"],["ВЫКИНУТЫ серии >=24ч","drop24"],["потолок = настоящий протокольный max","prot"]];
for(const share of [0.005,0.01,0.02]){
  console.log(`\n## 3.2 доля суточного оборота HL: ${(100*share).toFixed(1)}%`);
  console.log(`| капитал | ${MODES.map(m=>m[0]).join(" | ")} |`);
  console.log(`|---|${MODES.map(()=>"---").join("|")}|`);
  for(const capital of [100000,300000,1000000,3000000]){
    const cells=MODES.map(([,mode])=>{ const r=run({SRC:build(mode),capital,share});
      return `${pc(r.apr)} / $${r.usd.toFixed(0)}`; });
    console.log(`| $${(capital/1e6).toFixed(2)}M | ${cells.join(" | ")} |`);
  }
}
