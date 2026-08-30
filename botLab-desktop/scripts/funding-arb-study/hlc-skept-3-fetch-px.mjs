import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const TOP20=["TRUMP","FARTCOIN","HYPE","LINK","AAVE","PENDLE","UNI","NEAR","CRV","LTC","TAO","ETH","BTC","ONDO","DOGE","BNB","FET","SUI","AVAX","ARB"];
const MAJ10=["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC"];
const coins=[...new Set([...TOP20,...MAJ10,...L.all.keys()])];
const out={};
for(const c of coins){
  const rows=L.all.get(c); if(!rows) continue;
  const st=rows[0].tsHour*1000, en=rows[rows.length-1].tsHour*1000+3600000;
  let acc=[]; let cur=st;
  while(cur<en){
    let r; try{ r=await L.hlInfo({type:"candleSnapshot",req:{coin:c,interval:"1h",startTime:cur,endTime:en}});}catch(e){ break; }
    if(!r||!r.length) break;
    acc.push(...r); const last=r[r.length-1].t; if(last<=cur) break; cur=last+3600000;
    if(r.length<4000) break;
  }
  const m=new Map(); for(const k of acc) m.set(Math.floor(k.t/3600000), Number(k.c));
  out[c]=[...m.entries()].sort((a,b)=>a[0]-b[0]);
  process.stdout.write(`${c}:${out[c].length} `);
}
fs.writeFileSync("hlc-skept-px.json",JSON.stringify(out));
console.log("\nсохранено", Object.keys(out).length);
