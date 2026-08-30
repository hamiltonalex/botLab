// Б3/Б4 итог. Реалистичная жизнь сдвига T=60с, цена эха против издержки, которую и так платим.
import { all, SP, YEAR, openPosition, accrueFromRows, closePosition, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
import fs from "node:fs";
const I=1e-4,C=5e-4,K=8;
const rate=(p)=>(p+Math.max(-C,Math.min(C,I-p)))/K;
const imp=JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`,"utf8"));
const cap=JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8"));
const BLv=imp.meta.bpsLevels;
function ladder(sd){const p=BLv.map(b=>[sd.ntlAtBps[String(b)],b]).filter(x=>x[0]>0);if(p.length<2)return null;
 let sx=0,sy=0,sxx=0,sxy=0;for(const[x,b]of p){const lx=Math.log(x),ly=Math.log(b);sx+=lx;sy+=ly;sxx+=lx*lx;sxy+=lx*ly;}
 const n=p.length,k=(n*sxy-sx*sy)/(n*sxx-sx*sx);return{a:Math.exp((sy-k*sx)/n),k,cap:sd.visibleNtl};}
const marg=(L,X)=>L.a*Math.pow(X,L.k), vwap=(L,X)=>marg(L,X)/(1+L.k);
function legYear(t,rows,dBps){const d=dBps*1e-4,n=rows.length;
 const rr=dBps===0?rows:rows.map((r,i)=>((i===0||i===n-1)&&Number.isFinite(r.hl_premium))
  ?{...r,hl_premium:r.hl_premium-d,hl_rate:rate(r.hl_premium-d)}:r);
 const p=openPosition({strategy:"two",instrumentKey:t,config:"B",capital:1e6,leverage:1,nowMs:rr[0].tsHour*1000,roundTripCost:0});
 accrueFromRows(p,rr,rr.at(-1).tsHour*1000+3600000);closePosition(p,rr.at(-1).tsHour*1000+3600000);
 return p.accruals.reduce((s,a)=>s+(a.dPnlHl||0),0)/1e6;}

const T=60, SZ=[1e4,5e4,1e5,5e5,1e6,5e6];
const toks=Object.entries(imp.tokens).map(([t,o])=>({t,o,vol:o.volume?.medPeriodNtl||0,vtoday:o.volume?.todayNtl||0}))
 .sort((a,b)=>b.vol-a.vol).filter(x=>all.get(x.t)?.length===YEAR).slice(0,20);

// Тейкерская часть круга по ноге HL из costs.js (без ноги GMX): 0.045% * 2 стороны
const hlTakerBps = DEFAULT_COSTS.hlTaker*DEFAULT_COSTS.hlSides*100;
console.log(`Модель издержек проекта, тейкерский круг по ноге HL = ${hlTakerBps} бп от ноционала (costs.js hlTaker*hlSides).`);
console.log(`Круг по обеим ногам на $1M: $${roundTripCost(DEFAULT_COSTS,1e6,false).toLocaleString("en-US")}\n`);
console.log(`ЦЕНА СОБСТВЕННОГО РАЗМЕРА в ставке HL при жизни сдвига T=${T}с, движком, бп от ноционала за круг:`);
console.log(`токен    ` + SZ.map(s=>(s>=1e6?`${s/1e6}M`:`${s/1e3}k`).padStart(10)).join("") + `   |  проскальз.$1M  эхо/проскальз.`);
const fin=[];
for (const {t,o} of toks) {
  const rows=all.get(t), L=ladder(o.raw.sell), base=legYear(t,rows,0);
  const cells=SZ.map(S=>{ if(!L||S>L.cap) return "   ПОТОЛОК";
    const D=(marg(L,S+6000)-marg(L,6000))*T/3600;
    return (1e4*(base-legYear(t,rows,D))).toFixed(5).padStart(10); });
  const slip1M = L? (vwap(L,1e6)*2) : NaN;
  const D1M=L?(marg(L,1e6+6000)-marg(L,6000))*T/3600:NaN;
  const echo1M=L?1e4*(base-legYear(t,rows,D1M)):NaN;
  console.log(t.padEnd(9)+cells.join("")+`   |${slip1M.toFixed(2).padStart(10)}бп ${(100*echo1M/slip1M).toFixed(3).padStart(10)}%`);
  fin.push({t,base,slip1M,echo1M,vis:L?.cap,vol:o.volume.medPeriodNtl});
}
console.log(`\nПРАКТИЧЕСКИЙ ПОТОЛОК (не разбавление, а стакан и оборот):`);
console.log(`токен    год.нога  1% сут.оборота  видимый стакан  S где проскальз.=10% дохода || GMX встречная база  GMX S при разбавл.10%`);
for (const {t,o,vol} of toks) {
  const L=ladder(o.raw.sell), base=fin.find(x=>x.t===t).base; if(!L) continue;
  let lo=1e2,hi=1e12; for(let i=0;i<70;i++){const m=Math.sqrt(lo*hi); if(vwap(L,m)*2*1e-4 < 0.10*base) lo=m; else hi=m;}
  const c=cap.find(x=>x.t===t), B=c?Math.min(c.oiLong,c.oiShort):NaN;
  const g=(x)=>!Number.isFinite(x)?"       -":x>=1e6?`$${(x/1e6).toFixed(1)}M`.padStart(8):`$${Math.round(x/1e3)}k`.padStart(8);
  console.log(`${t.padEnd(9)}${(100*base).toFixed(1).padStart(6)}%  ${g(vol/100)}        ${g(L.cap)}        ${g(Math.sqrt(lo*hi))}        ||${g(B)}            ${g(B/9)}`);
}
