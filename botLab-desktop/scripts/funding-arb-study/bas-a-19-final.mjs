import fs from "node:fs";
const imp=JSON.parse(fs.readFileSync("bas-a-impact3.json","utf8"));
const carry=JSON.parse(fs.readFileSync("bas-a-carry.json","utf8"));
const cands=JSON.parse(fs.readFileSync("bas-a-cands.json","utf8"));
const MAP={HYPE:"HYPE",UBTC:"BTC",UETH:"ETH",USOL:"SOL",UZEC:"ZEC",UPUMP:"PUMP",UENA:"ENA",UXPL:"XPL"};
const MML={HYPE:10,UBTC:40,UETH:25,USOL:20,UZEC:10,UPUMP:10,UENA:10,UXPL:10,PURR:3};
const SZ=[5e4,1e5,2.5e5,5e5,1e6,2e6];
console.log("N_max = largest size in the probe whose one-way entry cost (impact+11.5bp taker fees) stays <= 25bp");
console.log("coin   carryAPR  spotVol24h$   N_max$   entryCost@Nmax  carry$/yr on N_max  roundTripCost/carry  MM%  liqMove@M=0.5N");
let tot=0; const share={};
for (const c of cands){
  const o=imp[c.base]; const k=MAP[c.base]; const cr=carry[k];
  if(!o||!o["spot buy"]||!cr) continue;
  let best=0,bc=NaN;
  SZ.forEach((z,i)=>{const a=o["spot buy"].r[i],b=o["perp sell"].r[i]; if(a==null||b==null)return; const t=a+b+11.5; if(t<=25){best=z;bc=t;}});
  if(!best) { console.log(`${c.base.padEnd(6)} ${(100*cr.apr).toFixed(2)}%  -- no size clears 25bp --`); continue; }
  const cash=best*cr.apr; tot+=cash; share[c.base]=cash;
  const mm=100/(2*MML[c.base]);
  console.log(`${c.base.padEnd(6)} ${(100*cr.apr).toFixed(2).padStart(7)}% ${Math.round(c.spotVol).toLocaleString().padStart(12)} ${best.toLocaleString().padStart(9)} ${bc.toFixed(1).padStart(13)}bp ${Math.round(cash).toLocaleString().padStart(17)} ${(2*bc/(1e4*cr.apr)*100).toFixed(1).padStart(19)}% ${mm.toFixed(2).padStart(5)} ${(100*(0.5-mm/100)).toFixed(0).padStart(13)}%`);
}
console.log(`\ntotal carry $/yr at these sizes: $${Math.round(tot).toLocaleString()}`);
for (const [k,v] of Object.entries(share).sort((a,b)=>b[1]-a[1])) console.log(`  ${k.padEnd(6)} $${Math.round(v).toLocaleString().padStart(8)}  ${(100*v/tot).toFixed(1)}%`);
console.log("\nCapital efficiency: capital = spot notional N + perp margin M. Return on capital = carryAPR * N/(N+M).");
for (const m of [0.2,0.3,0.5,1.0]) console.log(`  M=${m}N -> RoC factor ${(1/(1+m)).toFixed(3)};  HYPE ${(12.08/(1+m)).toFixed(2)}%  UBTC ${(7.28/(1+m)).toFixed(2)}%  UETH ${(7.53/(1+m)).toFixed(2)}%`);
