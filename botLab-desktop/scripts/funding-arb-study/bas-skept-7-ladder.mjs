import fs from "node:fs";
const PAIRS=[["HYPE","@107"],["BTC","@142"],["ETH","@151"],["SOL","@156"],["ZEC","@272"],["PUMP","@188"]];
const IVS=["30m","2h","4h","8h","12h"];
const ld=(c,iv)=>{const f=`bas-skept-c/${c.replace("@","at")}_${iv}.json`;return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):null;};
const q=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.max(0,Math.round(p*(s.length-1))))];};
// notional floor per bar, scaled by interval length in hours
const HRS={"30m":0.5,"2h":2,"4h":4,"8h":8,"12h":12};
const FLOOR=25000; // $ per hour of spot turnover in the bar
function series(perp,spot,iv,warmDays){
  const P=ld(perp,iv),S=ld(spot,iv); if(!P||!S)return null;
  const t0=S[0].t+warmDays*86400000;
  const sm=new Map(S.map(r=>[r.t,r]));
  const out=[];
  for(const p of P){const s=sm.get(p.t); if(!s||p.t<t0)continue;
    const ntl=(+s.v)*(+s.c), need=FLOOR*HRS[iv];
    if(!(s.n>=20)||!(ntl>=need))continue;
    if(!(p.n>=20))continue;
    out.push({t:p.t,v:(+p.c-+s.c)/(+s.c)*1e4});
  }
  return out;
}
const drawup=(b)=>{let mn=Infinity,mx=0,at=-1;for(let i=0;i<b.length;i++){if(b[i].v<mn)mn=b[i].v;const d=b[i].v-mn;if(d>mx){mx=d;at=i;}}return{mx,at};};
const res={};
console.log(`filter: spot bar notional >= $${FLOOR}/h, spot n>=20, perp n>=20, warmup 14d after spot pair start`);
console.log("coin  iv    kept  drop%  span            med    p1     p99    min    max   DRAWUP  when");
for(const [perp,spot] of PAIRS){res[perp]={};
 for(const iv of IVS){
  const all=(()=>{const P=ld(perp,iv),S=ld(spot,iv);if(!P||!S)return 0;const sm=new Map(S.map(r=>[r.t,r]));return P.filter(p=>sm.has(p.t)).length;})();
  const b=series(perp,spot,iv,14); if(!b||b.length<50)continue;
  const vs=b.map(x=>x.v),du=drawup(b);
  res[perp][iv]={n:b.length,med:q(vs,.5),p1:q(vs,.01),p99:q(vs,.99),min:Math.min(...vs),max:Math.max(...vs),du:du.mx,duT:new Date(b[du.at].t).toISOString().slice(0,13),
    from:new Date(b[0].t).toISOString().slice(0,10),days:((b[b.length-1].t-b[0].t)/864e5).toFixed(0)};
  const o=res[perp][iv];
  console.log(`${perp.padEnd(5)} ${iv.padEnd(4)} ${String(o.n).padStart(5)} ${(100-100*o.n/all).toFixed(0).padStart(5)}% ${o.from} ${String(o.days).padStart(4)}d ${o.med.toFixed(1).padStart(6)} ${o.p1.toFixed(0).padStart(6)} ${o.p99.toFixed(0).padStart(6)} ${o.min.toFixed(0).padStart(6)} ${o.max.toFixed(0).padStart(6)} ${o.du.toFixed(0).padStart(7)} ${o.duT}`);
 }}
fs.writeFileSync("bas-skept-ladder.json",JSON.stringify(res,null,1));
