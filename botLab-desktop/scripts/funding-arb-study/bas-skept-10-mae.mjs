import fs from "node:fs";
const ld=(c,iv)=>JSON.parse(fs.readFileSync(`bas-skept-c/${c.replace("@","at")}_${iv}.json`,"utf8"));
const q=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.max(0,Math.round(p*(s.length-1))))];};
console.log("MAE = max adverse basis move (basis rise) within horizon from entry bar. 2h bars, filtered, full 403d window.");
console.log("coin  n     H=7d med/p95/max   H=30d med/p95/max   H=90d med/p95/max   | realized dBasis 30d (p5/med/p95)");
for(const [perp,spot] of [["HYPE","@107"],["BTC","@142"],["ETH","@151"],["SOL","@156"]]){
 const P=ld(perp,"2h"),S=ld(spot,"2h"),sm=new Map(S.map(r=>[r.t,r]));
 const b=[];const t0=S[0].t+14*864e5;
 for(const p of P){const s=sm.get(p.t);if(!s||p.t<t0)continue;const ntl=(+s.v)*(+s.c);if(!(s.n>=20&&p.n>=20&&ntl>=50000))continue;
  b.push({t:p.t,v:(+p.c-+s.c)/(+s.c)*1e4});}
 const line=[perp.padEnd(5),String(b.length).padStart(5)];
 for(const Hd of [7,30,90]){
  const H=Hd*12; const m=[];
  for(let i=0;i+H<b.length;i++){let mx=0;for(let j=i+1;j<=i+H;j++){const d=b[j].v-b[i].v;if(d>mx)mx=d;}m.push(mx);}
  line.push(` ${q(m,.5).toFixed(0)}/${q(m,.95).toFixed(0)}/${Math.max(...m).toFixed(0)}`.padEnd(18));
 }
 const H=30*12,r=[];for(let i=0;i+H<b.length;i++)r.push(b[i+H].v-b[i].v);
 line.push(` | ${q(r,.05).toFixed(0)}/${q(r,.5).toFixed(0)}/${q(r,.95).toFixed(0)}`);
 console.log(line.join(" "));
}
