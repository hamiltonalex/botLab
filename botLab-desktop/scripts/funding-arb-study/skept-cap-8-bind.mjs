// Какая нога РЕАЛЬНО узкая: доля ограниченных долларов, а не «какое число меньше в таблице».
import fs from "node:fs";
import { all, full, YEAR, H1, scanTwoLeg, openPosition, accrueFromRows, closePosition, positionSummary,
         DEFAULT_COSTS, roundTripCost, capRows, pc, SP } from "./skept-cap-lib.mjs";
const vol=JSON.parse(fs.readFileSync(`${SP}/skept-hlvol.json`,"utf8"));
const byT=new Map(capRows.map(r=>[r.t,r]));
const W=90,H=30,N=3,trainH=W*H1,holdH=H*H1;
const per_=[];for(let i=trainH;i+24<=YEAR;i+=holdH){const te=Math.min(YEAR,i+holdH);if(te-i<24)break;per_.push([i,te]);}
const med=(xs)=>{const a=xs.slice().sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):NaN;};
const tab=per_.map(([i,te])=>{
  const t0=all.get(full[0])[i-trainH].tsHour*1000,t1=all.get(full[0])[i].tsHour*1000;const m=new Map();
  for(const t of full){const rows=all.get(t);const sc=scanTwoLeg(rows.slice(i-trainH,i),{token:t});if(!sc)continue;
   const b=sc.chosen==="A"?sc.A:sc.B;if(!(b.netMedian>0))continue;
   const w=rows.slice(i,te);const p=openPosition({strategy:"two",instrumentKey:t,config:sc.chosen,capital:1,leverage:1,nowMs:w[0].tsHour*1000,roundTripCost:0});
   accrueFromRows(p,w,w[w.length-1].tsHour*1000+3600000);closePosition(p,w[w.length-1].tsHour*1000+3600000);
   const vs=(vol[t]||[]).filter(c=>c.t>=t0&&c.t<t1).map(c=>c.ntl).filter(Number.isFinite);
   m.set(t,{cfg:sc.chosen,v:b.netMedian,g1:positionSummary(p).grossPnl,hl:vs.length>=10?med(vs):0});}
  return m;});

for (const share of [0.01,0.02,0.05]) {
 console.log(`\n# доля суточного оборота HL = ${(100*share).toFixed(0)}%, запас 5x, гладкая модель K=8`);
 console.log("| капитал | $ ограничено ногой GMX | $ ногой HL | $ не ограничено | вывод |");
 for (const capital of [30000,100000,300000,1000000]) {
  const slot=capital/N; let gmxB=0,hlB=0,freeB=0;
  for (const m of tab) {
   const cand=full.filter(t=>m.has(t)).map(t=>({t,...m.get(t)})).sort((a,b)=>b.v-a.v);
   let left=capital,n=0;
   for(const s of cand){ if(n>=8||left<=1)break;
    const g=byT.get(s.t).avail, h=s.hl*share;
    const cp=Math.min(slot,g/5,h/5,left); if(cp<capital/100)continue;
    if(cp===slot||cp===left) freeB+=cp; else if(g/5<=h/5) gmxB+=cp; else hlB+=cp;
    left-=cp;n++;}
  }
  const tot=gmxB+hlB+freeB;
  console.log(`| $${capital} | ${(100*gmxB/tot).toFixed(0)}% | ${(100*hlB/tot).toFixed(0)}% | ${(100*freeB/tot).toFixed(0)}% | ${gmxB>hlB?"узкая GMX":"узкая HL"} |`);
 }
}
