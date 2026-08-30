import fs from "node:fs";
const ld=(c,iv)=>JSON.parse(fs.readFileSync(`bas-skept-c/${c.replace("@","at")}_${iv}.json`,"utf8"));
function show(perp,spot,iv,fromISO,toISO){
  const P=ld(perp,iv),S=ld(spot,iv),sm=new Map(S.map(r=>[r.t,r]));
  const a=Date.parse(fromISO),b=Date.parse(toISO);
  console.log(`\n=== ${perp} ${iv} ${fromISO}..${toISO}`);
  console.log("time             spotC      perpC    basis_bp  spotNtl$   spotN    perpNtl$   perpN");
  for(const p of P){if(p.t<a||p.t>b)continue;const s=sm.get(p.t);if(!s)continue;
    const v=(+p.c-+s.c)/(+s.c)*1e4;
    console.log(`${new Date(p.t).toISOString().slice(0,16)} ${(+s.c).toFixed(3).padStart(10)} ${(+p.c).toFixed(3).padStart(10)} ${v.toFixed(1).padStart(8)} ${((+s.v)*(+s.c)/1e6).toFixed(2).padStart(8)}M ${String(s.n).padStart(7)} ${((+p.v)*(+p.c)/1e6).toFixed(2).padStart(9)}M ${String(p.n).padStart(7)}`);}
}
show("HYPE","@107","2h","2025-12-16T00:00Z","2025-12-18T00:00Z");
show("SOL","@156","2h","2026-02-04T12:00Z","2026-02-06T00:00Z");
