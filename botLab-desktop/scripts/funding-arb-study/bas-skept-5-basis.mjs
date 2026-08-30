import fs from "node:fs";
const PAIRS=[["HYPE","@107"],["BTC","@142"],["ETH","@151"],["SOL","@156"],["ZEC","@272"],["PUMP","@188"]];
const IVS=["30m","2h","4h","8h","12h"];
const ld=(c,iv)=>{const f=`bas-skept-c/${c.replace("@","at")}_${iv}.json`;return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):null;};
const q=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.max(0,Math.floor(p*(s.length-1))))];};
const drawup=(b)=>{let mn=Infinity,mx=0,at=-1;for(let i=0;i<b.length;i++){if(b[i].v<mn){mn=b[i].v;}const d=b[i].v-mn;if(d>mx){mx=d;at=i;}}return{mx,at};};
const out={};
for(const [perp,spot] of PAIRS){
 out[perp]={};
 for(const iv of IVS){
  const P=ld(perp,iv),S=ld(spot,iv); if(!P||!S)continue;
  const sm=new Map(S.map(r=>[r.t,r]));
  const raw=[],flt=[];
  for(const p of P){const s=sm.get(p.t); if(!s)continue;
    const v=(Number(p.c)-Number(s.c))/Number(s.c)*10000;
    raw.push({t:p.t,v,pn:p.n,sn:s.n});
    if(p.n>=3&&s.n>=3) flt.push({t:p.t,v});
  }
  const du=drawup(flt), duR=drawup(raw);
  const vs=flt.map(x=>x.v);
  out[perp][iv]={n:flt.length,nraw:raw.length,med:q(vs,.5),p1:q(vs,.01),p99:q(vs,.99),min:Math.min(...vs),max:Math.max(...vs),
    du:du.mx,duT:du.at>=0?new Date(flt[du.at].t).toISOString().slice(0,13):null,duRaw:duR.mx,
    spanD:((P[P.length-1].T-P[0].t)/86400000).toFixed(0),
    thinSpot:(raw.filter(x=>x.sn<3).length/raw.length*100).toFixed(1),thinPerp:(raw.filter(x=>x.pn<3).length/raw.length*100).toFixed(1),
    medSn:q(raw.map(x=>x.sn),.5),medPn:q(raw.map(x=>x.pn),.5)};
 }
}
fs.writeFileSync("bas-skept-basis.json",JSON.stringify(out,null,1));
console.log("coin  iv    span  n     med    p1     p99    min      max     DRAWUP  when            drawupNoFilt  thinSpot% medSpotTrades");
for(const k of Object.keys(out))for(const iv of IVS){const o=out[k][iv];if(!o)continue;
 console.log(`${k.padEnd(5)} ${iv.padEnd(4)} ${String(o.spanD).padStart(4)}d ${String(o.n).padStart(5)} ${o.med.toFixed(1).padStart(6)} ${o.p1.toFixed(1).padStart(7)} ${o.p99.toFixed(1).padStart(7)} ${o.min.toFixed(0).padStart(7)} ${o.max.toFixed(0).padStart(7)} ${o.du.toFixed(0).padStart(7)} ${String(o.duT).padStart(14)} ${o.duRaw.toFixed(0).padStart(9)} ${String(o.thinSpot).padStart(7)} ${String(o.medSn).padStart(6)}`);}
