// 11. Итог: три поправки сразу, с доверительным интервалом по 10 окнам ребалансировки.
import { all, YEAR, H1, scanTwoLeg, annualizeRow, maxOf, openPosition, accrueFromRows, closePosition, positionSummary } from "./skept-cap-lib.mjs";
import { CAP, PER, YRS, costRound } from "./run4-lib.mjs";
import { caps } from "./run4-grid.mjs";
const f=(x)=>(x<0?"-$":"$")+Math.round(Math.abs(x)).toLocaleString("en-US");
const SEC=3600*8760;
function clamp(rows,c){ if(!Number.isFinite(c))return rows; const m=c/SEC;
  return rows.map(r=>({...r,f_long:Math.max(-m,Math.min(m,r.f_long)),f_short:Math.max(-m,Math.min(m,r.f_short)),
    b_long:Math.min(m,r.b_long),b_short:Math.min(m,r.b_short),hl_rate:Math.max(-c/8760,Math.min(c/8760,r.hl_rate))})); }
function TABof(c){ const trainH=90*H1;
  return PER.map(([i,te])=>{ const m=new Map();
    for(const t of CAP.keys()){ const raw=all.get(t); if(!raw||raw.length!==YEAR)continue;
      const rows=clamp(raw,c); const sc=scanTwoLeg(rows.slice(i-trainH,i),{token:t}); if(!sc)continue;
      const b=sc.chosen==="A"?sc.A:sc.B; const v=b.netMedian; if(!(v>0))continue;
      const w=rows.slice(i,te);
      const p=openPosition({strategy:"two",instrumentKey:t,config:sc.chosen,capital:1,leverage:1,nowMs:w[0].tsHour*1000,roundTripCost:0});
      accrueFromRows(p,w,w[w.length-1].tsHour*1000+3600000); closePosition(p,w[w.length-1].tsHour*1000+3600000);
      m.set(t,{cfg:sc.chosen,v,g1:positionSummary(p).grossPnl,
               peak:maxOf(rows.slice(i-trainH,i).map(annualizeRow).map(a=>Math.max(Math.abs(a.net_A),Math.abs(a.net_B))))}); }
    return m; }); }
function led(T,{capital,N=3,K=8,sane=10,margin=1,hlVariant="correctedSqrt",gmxAdverse=false,causal=true,legs=1}){
  const out=[]; let held=new Map(); const bud=capital/legs;
  for(let pi=0;pi<T.length;pi++){ const hrs=PER[pi][1]-PER[pi][0];
    const cand=[...T[pi].entries()].filter(([,d])=>Number.isFinite(d.peak)&&d.peak<=sane).map(([t,d])=>({t,...d})).sort((a,b)=>b.v-a.v);
    let left=bud; const now=new Map();
    for(const s of cand){ if(now.size>=K||left<=1)break; const o={hlVariant,gmxAdverse,margin};
      const hi=Math.min(caps(s.t,s.cfg,o),bud/N,left); if(!(hi>10))continue;
      const g=causal?s.v*hrs/8760:s.g1; let best=0,bv=-Infinity;
      for(let k=0;k<=400;k++){const S=10*Math.pow(hi/10,k/400); if(S>hi)break;
        const v=g*S-costRound(s.t,s.cfg,S,o).total; if(v>bv){bv=v;best=S;}}
      if(!(bv>0))continue; const prev=held.get(s.t+s.cfg);
      const c=(prev&&Math.abs(prev-best)/best<1e-9)?0:costRound(s.t,s.cfg,best,o).total;
      out.push({pi,t:s.t,net:s.g1*best-c}); now.set(s.t+s.cfg,best); left-=best; }
    held=now; }
  return out; }
const W=PER.map(([a,b])=>(b-a)/8760);
function boot(L){ const per=Array.from({length:10},(_,i)=>L.filter(r=>r.pi===i).reduce((a,x)=>a+x.net,0));
  let s=11; const rnd=()=>{s=(s*1103515245+12345)&0x7fffffff;return s/0x7fffffff;}; const o=[];
  for(let b=0;b<20000;b++){let n=0,w=0;for(let k=0;k<10;k++){const j=Math.floor(rnd()*10);n+=per[j];w+=W[j];}o.push(n/w);}
  o.sort((a,b)=>a-b);
  return {tot:per.reduce((a,x)=>a+x,0)/YRS,p5:o[1000],p50:o[10000],p95:o[19000],below:o.filter(x=>x<25000).length/20000,
          pos:per.filter(x=>x>0).length,best:100*Math.max(...per)/per.reduce((a,x)=>a+x,0)}; }
const TinF=TABof(Infinity), T10=TABof(10);
console.log("## Наращивание поправок, капитал взят на плато каждого угла");
console.log("| строка | $/год | 90% ИД по 10 окнам | P(<$25k) | плюсовых окон | доля лучшего окна |");
console.log("|---|---|---|---|---|---|");
const rows=[
  ["прогон, БАЗА $1M",TinF,{capital:1e6,causal:false}],
  ["+ причинный размер",TinF,{capital:1e6,causal:true}],
  ["+ потолок ставки 1000% годовых",T10,{capital:1e6,causal:true}],
  ["+ капитал под две ноги",T10,{capital:1e6,causal:true,legs:2}],
  ["прогон, ПРЕДЕЛЬНО 10% $1M",TinF,{capital:1e6,causal:false,margin:10,hlVariant:"raw",gmxAdverse:true,sane:5}],
  ["+ причинный размер",TinF,{capital:1e6,causal:true,margin:10,hlVariant:"raw",gmxAdverse:true,sane:5}],
  ["+ потолок ставки 1000% годовых",T10,{capital:1e6,causal:true,margin:10,hlVariant:"raw",gmxAdverse:true,sane:5}],
  ["+ капитал под две ноги",T10,{capital:1e6,causal:true,legs:2,margin:10,hlVariant:"raw",gmxAdverse:true,sane:5}],
];
for(const [lbl,T,o] of rows){ const B=boot(led(T,o));
  console.log(`| ${lbl} | ${f(B.tot)} | [${f(B.p5)} .. ${f(B.p95)}] | ${(100*B.below).toFixed(0)}% | ${B.pos}/10 | ${B.best.toFixed(0)}% |`); }
console.log("\n## Тот же полный стек по капиталу (потолок 1000%, причинный размер, две ноги)");
for (const [lbl,o] of [["БАЗА",{}],["КОНСЕРВ 20%",{margin:5,hlVariant:"raw",gmxAdverse:true,sane:5}],["ПРЕДЕЛЬНО 10%",{margin:10,hlVariant:"raw",gmxAdverse:true,sane:5}]]){
  const G=[1e5,3e5,1e6,3e6,1e7];
  console.log(`  ${lbl}: `+G.map(c=>`${f(c)}=${f(led(T10,{capital:c,causal:true,legs:2,...o}).reduce((a,b)=>a+b.net,0)/YRS)}`).join(", ")); }
