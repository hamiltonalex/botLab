import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const vol=JSON.parse(fs.readFileSync("vol63.json","utf8"));
function basket(list,label,fromH=0){
  const ts=list.filter(t=>L.all.get(t)); if(!ts.length) return;
  const len=Math.min(...ts.map(t=>L.all.get(t).length-fromH));
  const arr=new Array(len).fill(0); const w=1/ts.length;
  for(const t of ts){ const rows=L.all.get(t); const sl=rows.slice(rows.length-len);
    const r=L.runLeg(sl,"B",10000); r.accruals.forEach((a,i)=>{ if(i<len) arr[i]+=w*(a.dPnlHl||0); }); }
  let c=0,peak=0,dd=0; const p=[]; for(const x of arr){c+=x; p.push(c); if(c>peak)peak=c; if(c-peak<dd)dd=c-peak;}
  const wq=(W)=>{let worst=Infinity; for(let i=0;i+W<=len;i+=24) worst=Math.min(worst,p[i+W-1]-p[i]); return worst;};
  const yrs=len/8760;
  console.log(`${label.padEnd(38)} APR ${L.pc(c/10000/yrs).padStart(8)}  просадка $${dd.toFixed(0).padStart(6)} (${L.pc(dd/10000)})  худш.30д $${wq(720).toFixed(0).padStart(6)}  90д $${wq(2160).toFixed(0).padStart(6)}`);
}
const THEIRS=["BTC","ETH","SOL","LINK","AAVE","UNI","DOGE","LTC","NEAR","ARB"];
basket(THEIRS,"их \"10 мажоров\" (замер 1)");
basket(["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC"],"10 по капитализации (нейтрально)");
// ex ante: топ-10 по обороту HL за ПЕРВЫЕ 30 дней окна
const st=L.all.get("BTC")[0].tsHour*1000;
const rank=Object.entries(vol).map(([t,a])=>{
  const first=a.filter(x=>x.t>=st&&x.t<st+30*86400000); const v=first.length?first.reduce((s,x)=>s+x.ntl,0)/first.length:0;
  return {t,v};
}).filter(r=>L.all.get(r.t)&&r.v>0).sort((a,b)=>b.v-a.v);
console.log("\nex-ante ранжирование по обороту HL первых 30 дней окна:", rank.slice(0,12).map(r=>r.t).join(" "));
basket(rank.slice(0,10).map(r=>r.t),"топ-10 по обороту ex ante");
basket(rank.slice(0,20).map(r=>r.t),"топ-20 по обороту ex ante");
basket(rank.slice(0,30).map(r=>r.t),"топ-30 по обороту ex ante");
// ex ante по керри первых 90 дней -> держим остаток года
const H=2160;
const sc=[...L.all.keys()].filter(t=>L.all.get(t).length===8761).map(t=>{
  const rows=L.all.get(t); const tr=rows.slice(0,H); const r=L.runLeg(tr,"B",10000);
  return {t,tr:r.dHl};
}).sort((a,b)=>b.tr-a.tr);
console.log("\nex-ante отбор по керри первых 90 дней, держим остальные 275 дней:");
for(const N of [5,10,20]){
  const ts=sc.slice(0,N).map(s=>s.t);
  const len=8761-H; const arr=new Array(len).fill(0); const w=1/N;
  for(const t of ts){ const r=L.runLeg(L.all.get(t).slice(H),"B",10000); r.accruals.forEach((a,i)=>{if(i<len)arr[i]+=w*(a.dPnlHl||0);}); }
  let c=0,peak=0,dd=0,p=[]; for(const x of arr){c+=x;p.push(c);if(c>peak)peak=c;if(c-peak<dd)dd=c-peak;}
  const yrs=len/8760; const wq=(W)=>{let worst=Infinity;for(let i=0;i+W<=len;i+=24)worst=Math.min(worst,p[i+W-1]-p[i]);return worst;};
  console.log(`  N=${N} (${ts.slice(0,6).join(",")}${N>6?",…":""}): APR ${L.pc(c/10000/yrs)}, просадка ${L.pc(dd/10000)}, худш.30д $${wq(720).toFixed(0)}`);
}
