// 10. Тот же движок, те же правила, но часовой множитель финансирования GMX ограничен сверху
//     протокольно правдоподобным потолком. Ставка 3.26 млн % годовых = 1.2e-3 за секунду,
//     это на 4-5 порядков выше типового maxFundingFactorPerSecond. Ничего кроме потолка не менялось.
import { all, YEAR, H1, scanTwoLeg, annualizeRow, maxOf, openPosition, accrueFromRows,
         closePosition, positionSummary, median } from "./skept-cap-lib.mjs";
import { CAP, PER, YRS, costRound, med, VOL } from "./run4-lib.mjs";
import { caps } from "./run4-grid.mjs";
const f=(x)=>(x<0?"-$":"$")+Math.round(Math.abs(x)).toLocaleString("en-US");
const SEC=3600*8760;
function clampRows(rows,capApr){
  if(!Number.isFinite(capApr)) return rows;
  const m=capApr/SEC;                       // потолок на ПОСЕКУНДНЫЙ множитель
  return rows.map(r=>({...r,
    f_long:Math.max(-m,Math.min(m,r.f_long)), f_short:Math.max(-m,Math.min(m,r.f_short)),
    b_long:Math.min(m,r.b_long), b_short:Math.min(m,r.b_short),
    hl_rate:Math.max(-capApr/8760,Math.min(capApr/8760,r.hl_rate))}));
}
function buildTAB(capApr){
  const trainH=90*H1;
  return PER.map(([i,te])=>{
    const m=new Map();
    for(const t of CAP.keys()){ const raw=all.get(t); if(!raw||raw.length!==YEAR) continue;
      const rows=clampRows(raw,capApr);
      const sc=scanTwoLeg(rows.slice(i-trainH,i),{token:t}); if(!sc) continue;
      const b=sc.chosen==="A"?sc.A:sc.B; const v=b.netMedian; if(!(v>0)) continue;
      const w=rows.slice(i,te);
      const p=openPosition({strategy:"two",instrumentKey:t,config:sc.chosen,capital:1,leverage:1,nowMs:w[0].tsHour*1000,roundTripCost:0});
      accrueFromRows(p,w,w[w.length-1].tsHour*1000+3600000); closePosition(p,w[w.length-1].tsHour*1000+3600000);
      const pk=maxOf(rows.slice(i-trainH,i).map(annualizeRow).map(a=>Math.max(Math.abs(a.net_A),Math.abs(a.net_B))));
      m.set(t,{cfg:sc.chosen,v,g1:positionSummary(p).grossPnl,peak:pk});
    }
    return m;
  });
}
function sim(TABx,{capital,N=3,K=8,sane=10,margin=1,hlVariant="correctedSqrt",gmxAdverse=false,causal}){
  const led=[]; let held=new Map();
  for(let pi=0;pi<TABx.length;pi++){ const hrs=PER[pi][1]-PER[pi][0];
    const cand=[...TABx[pi].entries()].filter(([,d])=>Number.isFinite(d.peak)&&d.peak<=sane).map(([t,d])=>({t,...d})).sort((a,b)=>b.v-a.v);
    let left=capital; const now=new Map();
    for(const s of cand){ if(now.size>=K||left<=1)break;
      const o={hlVariant,gmxAdverse,margin};
      const hi=Math.min(caps(s.t,s.cfg,o),capital/N,left); if(!(hi>10))continue;
      const g=causal?s.v*hrs/8760:s.g1;
      let best=0,bv=-Infinity;
      for(let k=0;k<=400;k++){const S=10*Math.pow(hi/10,k/400); if(S>hi)break;
        const v=g*S-costRound(s.t,s.cfg,S,o).total; if(v>bv){bv=v;best=S;}}
      if(!(bv>0))continue;
      const prev=held.get(s.t+s.cfg);
      const c=(prev&&Math.abs(prev-best)/best<1e-9)?0:costRound(s.t,s.cfg,best,o).total;
      led.push({pi,t:s.t,net:s.g1*best-c}); now.set(s.t+s.cfg,best); left-=best; }
    held=now; }
  return led.reduce((a,b)=>a+b.net,0)/YRS;
}
const TIGHT={margin:10,hlVariant:"raw",gmxAdverse:true,sane:5};
const CONS={margin:5,hlVariant:"raw",gmxAdverse:true,sane:5};
console.log("## Потолок часовой ставки финансирования GMX (годовых), $/год на плато");
console.log("| потолок | БАЗА $1M прогон | БАЗА $1M причинный | КОНСЕРВ 20% $1M причинный | ПРЕДЕЛЬНО 10% $1M причинный |");
console.log("|---|---|---|---|---|");
for (const capApr of [Infinity,100,10,3,1]) {
  const T=buildTAB(capApr===Infinity?Infinity:capApr);
  const nm=capApr===Infinity?"нет (как в прогоне)":`${100*capApr}% годовых`;
  console.log(`| ${nm} | ${f(sim(T,{capital:1e6,causal:false}))} | ${f(sim(T,{capital:1e6,causal:true}))} | ${f(sim(T,{capital:1e6,causal:true,...CONS}))} | ${f(sim(T,{capital:1e6,causal:true,...TIGHT}))} |`);
}
console.log("\n## Тот же потолок, БАЗА, по капиталу (причинный размер)");
const G=[1e5,3e5,1e6,3e6,1e7];
console.log("| потолок | "+G.map(f).join(" | ")+" |");
console.log("|"+"---|".repeat(G.length+1));
for (const capApr of [Infinity,10,3,1]) { const T=buildTAB(capApr);
  console.log(`| ${capApr===Infinity?"нет":100*capApr+"%"} | `+G.map(c=>f(sim(T,{capital:c,causal:true}))).join(" | ")+" |"); }
