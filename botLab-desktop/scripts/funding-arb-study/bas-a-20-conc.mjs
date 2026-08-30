import fs from "node:fs";
const imp=JSON.parse(fs.readFileSync("bas-a-impact3.json","utf8"));
const carry=JSON.parse(fs.readFileSync("bas-a-carry.json","utf8"));
const cands=JSON.parse(fs.readFileSync("bas-a-cands.json","utf8"));
const MAP={HYPE:"HYPE",UBTC:"BTC",UETH:"ETH",USOL:"SOL",UZEC:"ZEC",UPUMP:"PUMP",UENA:"ENA",UXPL:"XPL"};
for (const rule of [0.5,1,2]){
 console.log(`\n=== size rule: spot notional = ${rule*100}% of one day's spot volume (patient execution) ===`);
 console.log("coin   carryAPR  spotVol24h$    N$        carry$/yr    share   askDepthNow$  N/askDepth");
 const s={}; let tot=0;
 for (const c of cands){ const cr=carry[MAP[c.base]]; if(!cr) continue;
   const N=rule*c.spotVol; const cash=N*cr.apr; s[c.base]=cash; tot+=cash; }
 for (const c of cands){ const cr=carry[MAP[c.base]]; if(!cr) continue;
   const N=rule*c.spotVol, dep=imp[c.base]?.["spot buy"]?.dep;
   console.log(`${c.base.padEnd(6)} ${(100*cr.apr).toFixed(2).padStart(7)}% ${Math.round(c.spotVol).toLocaleString().padStart(12)} ${Math.round(N).toLocaleString().padStart(10)} ${Math.round(s[c.base]).toLocaleString().padStart(13)} ${(100*s[c.base]/tot).toFixed(1).padStart(7)}% ${(dep?Math.round(dep).toLocaleString():"?").padStart(13)} ${(dep?(N/dep).toFixed(1)+"x":"?").padStart(11)}`); }
 console.log(`TOTAL carry $/yr = $${Math.round(tot).toLocaleString()};  capital at spot leg only = $${Math.round(rule*cands.reduce((a,c)=>a+(carry[MAP[c.base]]?c.spotVol:0),0)).toLocaleString()}`);
}
