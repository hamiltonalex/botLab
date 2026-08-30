// Б3 (решающее). Короткое удержание + отношение "эхо в ставке" / "проскальзывание, которое и так платим".
import { all, SP, YEAR, openPosition, accrueFromRows, closePosition } from "./skept-cap-lib.mjs";
import fs from "node:fs";
const I=1e-4, C=5e-4, K=8, IN=6000;
const rate=(p)=>(p+Math.max(-C,Math.min(C,I-p)))/K;
const imp=JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`,"utf8"));
const BLv=imp.meta.bpsLevels;
function ladder(sd){const p=BLv.map(b=>[sd.ntlAtBps[String(b)],b]).filter(x=>x[0]>0);if(p.length<2)return null;
 let sx=0,sy=0,sxx=0,sxy=0;for(const[x,b]of p){const lx=Math.log(x),ly=Math.log(b);sx+=lx;sy+=ly;sxx+=lx*lx;sxy+=lx*ly;}
 const n=p.length,k=(n*sxy-sx*sy)/(n*sxx-sx*sx);return{a:Math.exp((sy-k*sx)/n),k,cap:sd.visibleNtl};}
const marg=(L,X)=>L.a*Math.pow(X,L.k), vwap=(L,X)=>marg(L,X)/(1+L.k);

function legWin(t, rows, dBps){ // сдвиг на первый и последний час окна
  const d=dBps*1e-4, n=rows.length;
  const rr = dBps===0?rows:rows.map((r,i)=>((i===0||i===n-1)&&Number.isFinite(r.hl_premium))
    ?{...r,hl_premium:r.hl_premium-d,hl_rate:rate(r.hl_premium-d)}:r);
  const p=openPosition({strategy:"two",instrumentKey:t,config:"B",capital:1e6,leverage:1,nowMs:rr[0].tsHour*1000,roundTripCost:0});
  accrueFromRows(p,rr,rr.at(-1).tsHour*1000+3600000); closePosition(p,rr.at(-1).tsHour*1000+3600000);
  return p.accruals.reduce((s,a)=>s+(a.dPnlHl||0),0)/1e6;
}
const toks=Object.entries(imp.tokens).map(([t,o])=>({t,o,vol:o.volume?.medPeriodNtl||0}))
  .sort((a,b)=>b.vol-a.vol).filter(x=>all.get(x.t)?.length===YEAR).slice(0,20);
const SZ=[1e5,1e6,5e6];

for (const H of [24, 168]) {
  console.log(`\n=== УДЕРЖАНИЕ ${H} ч. Сдвиг Δ(S) живёт ЦЕЛЫЙ час входа и целый час выхода (заведомо избыточно).`);
  console.log(`    Показано: цена эха в ставке в бп от ноционала за круг, и она же в % от дохода ноги за окно.`);
  console.log(`токен    доход ноги    ` + SZ.map(s=>`S=${s>=1e6?s/1e6+"M":s/1e3+"k"}`.padStart(22)).join(""));
  console.log(`         за ${String(H).padStart(3)}ч, бп   ` + SZ.map(()=>`      Δбп   эхо,бп  %дохода`).join(""));
  for (const {t,o} of toks) {
    const rows=all.get(t), L=ladder(o.raw.sell);
    let inc=0, loss=SZ.map(()=>0), nw=0;
    for (let i=0;i+H<=YEAR;i+=H){
      const w=rows.slice(i,i+H); const b=legWin(t,w,0); inc+=b; nw++;
      SZ.forEach((S,j)=>{ if(!L||S>L.cap) return; const D=marg(L,S+IN)-marg(L,IN); loss[j]+=b-legWin(t,w,D); });
    }
    const incBps=1e4*inc/nw;
    const cells=SZ.map((S,j)=>{
      if(!L||S>L.cap) return "        ПОТОЛОК       ";
      const D=marg(L,S+IN)-marg(L,IN), eBps=1e4*loss[j]/nw;
      return `${D.toFixed(2).padStart(9)}${eBps.toFixed(4).padStart(9)}${(100*eBps/incBps).toFixed(2).padStart(9)}%`;
    });
    console.log(`${t.padEnd(9)}${incBps.toFixed(1).padStart(9)}    ` + cells.join(""));
  }
}

console.log(`\n=== ОТНОШЕНИЕ, КОТОРОЕ НЕ ЗАВИСИТ ОТ РАЗМЕРА ===`);
console.log(`Эхо в ставке от нашего входа = Δ(S)/8 * (T/3600) бп за событие.`);
console.log(`Проскальзывание, которое мы и так платим на том же событии = vwap(S) бп.`);
console.log(`Отношение = (Δ/vwap)/8 * T/3600 = (1+k)/8 * T/3600, где k - наклон лестницы книги.\n`);
console.log(`токен    наклон k  (1+k)/8   эхо/проскальзывание при T = 10с    60с    300с   3600с`);
for (const {t,o} of toks) {
  const L=ladder(o.raw.sell); if(!L) continue;
  const c=(1+L.k)/8;
  console.log(`${t.padEnd(9)}${L.k.toFixed(3).padStart(7)}${c.toFixed(3).padStart(9)}   ` +
    [10,60,300,3600].map(T=>(100*c*T/3600).toFixed(3).padStart(8)+"%").join(""));
}
