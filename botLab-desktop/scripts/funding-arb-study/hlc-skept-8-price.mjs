import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const PX=JSON.parse(fs.readFileSync("hlc-skept-px-bin.json","utf8"));
const N=10000;
function legs(t){
  const rows=L.all.get(t), px=PX[t]; if(!px) return null;
  const m=new Map(px);
  const r=L.runLeg(rows,"B",N);
  // выравниваем по часам
  const carry=[], price=[]; let p0=null, cc=0;
  for(let i=0;i<rows.length;i++){
    const h=Math.floor(rows[i].tsHour/3600); const p=m.get(h); if(p===undefined) continue;
    if(p0===null) p0=p;
    cc+=r.accruals[i]?.dPnlHl||0;
    carry.push(cc); price.push(-N*(p/p0-1));
  }
  if(carry.length<2000) return null;
  const tot=carry.map((c,i)=>c+price[i]);
  const dd=(a)=>{let peak=-Infinity,d=0; for(const x of a){ if(x>peak)peak=x; if(x-peak<d)d=x-peak;} return d;};
  const H=carry.length;
  return {t,H,carry:carry.at(-1),price:price.at(-1),tot:tot.at(-1),
    aprC:carry.at(-1)/N*(8760/H), aprP:price.at(-1)/N*(8760/H), aprT:tot.at(-1)/N*(8760/H),
    ddC:dd(carry), ddP:dd(price), ddT:dd(tot), arrC:carry, arrP:price, arrT:tot};
}
const res=[]; for(const t of L.all.keys()){ const x=legs(t); if(x) res.push(x); }
res.sort((a,b)=>b.aprC-a.aprC);
console.log(`ГОЛЫЙ ШОРТ HL: керри против цены, $10k, ${res.length} монет с ценой`);
console.log(`монета   керри%/г   цена%/г    ИТОГО%/г   просад.керри  просад.ЦЕНЫ  просад.ИТОГО`);
for(const r of res.slice(0,12).concat(res.slice(-4)))
  console.log(`${r.t.padEnd(9)} ${L.pc(r.aprC).padStart(8)} ${L.pc(r.aprP).padStart(10)} ${L.pc(r.aprT).padStart(10)}   ${L.pc(r.ddC/N).padStart(8)}  ${L.pc(r.ddP/N).padStart(10)}  ${L.pc(r.ddT/N).padStart(10)}`);
const med=(f)=>L.q(res.map(f),0.5);
console.log(`\nМЕДИАНЫ по ${res.length}: керри ${L.pc(med(r=>r.aprC))}, цена ${L.pc(med(r=>r.aprP))}, итого ${L.pc(med(r=>r.aprT))}`);
console.log(`просадки медиана: керри ${L.pc(med(r=>r.ddC/N))}, ЦЕНА ${L.pc(med(r=>r.ddP/N))}, итого ${L.pc(med(r=>r.ddT/N))}`);
console.log(`отношение просадки цены к годовому керри, медиана = ${(med(r=>Math.abs(r.ddP)/Math.max(1,r.carry))).toFixed(1)}x`);
console.log(`монет, где итог голого шорта положителен: ${res.filter(r=>r.aprT>0).length}/${res.length}`);
// корзины
function bask(list,label){
  const ss=list.map(t=>res.find(r=>r.t===t)).filter(Boolean); if(!ss.length) return;
  const len=Math.min(...ss.map(s=>s.H)); const w=1/ss.length;
  const C=new Array(len).fill(0),P=new Array(len).fill(0);
  for(const s of ss){ const oC=s.arrC.slice(s.H-len), oP=s.arrP.slice(s.H-len);
    for(let i=0;i<len;i++){ C[i]+=w*(oC[i]-oC[0]); P[i]+=w*(oP[i]-oP[0]); } }
  const T=C.map((c,i)=>c+P[i]);
  const dd=(a)=>{let peak=-Infinity,d=0;for(const x of a){if(x>peak)peak=x;if(x-peak<d)d=x-peak;}return d;};
  const yrs=len/8760;
  console.log(`${label.padEnd(30)} керри ${L.pc(C.at(-1)/N/yrs).padStart(8)}  цена ${L.pc(P.at(-1)/N/yrs).padStart(9)}  итого ${L.pc(T.at(-1)/N/yrs).padStart(9)}  просадка ЦЕНЫ ${L.pc(dd(P)/N).padStart(9)}  просадка ИТОГО ${L.pc(dd(T)/N).padStart(9)}`);
}
console.log();
bask(["BTC","ETH","SOL","LINK","AAVE","UNI","DOGE","LTC","NEAR","ARB"],'их "10 мажоров"');
bask(["BTC","ETH"],"BTC+ETH");
bask(["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC"],"10 по капитализации");
bask([...L.all.keys()].filter(t=>PX[t]&&L.all.get(t).length===8761),"все с полной историей");
