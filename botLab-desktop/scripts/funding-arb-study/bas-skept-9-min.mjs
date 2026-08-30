import fs from "node:fs";
const ld=(c,iv)=>JSON.parse(fs.readFileSync(`bas-skept-c/${c.replace("@","at")}_${iv}.json`,"utf8"));
for(const [perp,spot] of [["HYPE","@107"],["SOL","@156"],["BTC","@142"],["ETH","@151"]]){
 const P=ld(perp,"2h"),S=ld(spot,"2h"),sm=new Map(S.map(r=>[r.t,r]));
 const rows=[];const t0=S[0].t+14*864e5;
 for(const p of P){const s=sm.get(p.t);if(!s||p.t<t0)continue;const ntl=(+s.v)*(+s.c);if(!(s.n>=20&&p.n>=20&&ntl>=50000))continue;
  rows.push({t:p.t,v:(+p.c-+s.c)/(+s.c)*1e4,sn:s.n,sN:ntl,pN:(+p.v)*(+p.c),sc:+s.c,pc:+p.c,sl:+s.l,sh:+s.h,pl:+p.l,ph:+p.h});}
 rows.sort((a,b)=>a.v-b.v);
 console.log(`\n${perp} 2h  most-negative 4:`);
 for(const r of rows.slice(0,4))console.log(`  ${new Date(r.t).toISOString().slice(0,16)} basis ${r.v.toFixed(1)} spot c=${r.sc} l/h=${r.sl}/${r.sh} n=${r.sn} $${(r.sN/1e6).toFixed(2)}M | perp c=${r.pc} l/h=${r.pl}/${r.ph} $${(r.pN/1e6).toFixed(1)}M`);
 rows.sort((a,b)=>b.v-a.v);
 console.log(`${perp} 2h  most-positive 4:`);
 for(const r of rows.slice(0,4))console.log(`  ${new Date(r.t).toISOString().slice(0,16)} basis ${r.v.toFixed(1)} spot c=${r.sc} n=${r.sn} $${(r.sN/1e6).toFixed(2)}M | perp c=${r.pc} $${(r.pN/1e6).toFixed(1)}M`);
}
