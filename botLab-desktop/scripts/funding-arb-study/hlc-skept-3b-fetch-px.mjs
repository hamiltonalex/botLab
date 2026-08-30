import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const info=JSON.parse(fs.readFileSync("hlc-bin-info.json","utf8"));
const syms=new Set((info.symbols||[]).filter(s=>s.contractType==="PERPETUAL"&&s.status==="TRADING"&&s.quoteAsset==="USDT").map(s=>s.baseAsset));
const map={PEPE:"1000PEPE",BONK:"1000BONK",SHIB:"1000SHIB",FLOKI:"1000FLOKI",XMR:null,MEGA:null,CC:null,MET:null,MON:null};
const out={};
for(const c of L.all.keys()){
  const rows=L.all.get(c);
  const st=rows[0].tsHour*1000, en=rows[rows.length-1].tsHour*1000+3600000;
  const sym=(map[c]!==undefined?map[c]:c); if(!sym) continue;
  if(!syms.has(sym)) continue;
  let acc=[],cur=st;
  while(cur<en){
    const u=`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}USDT&interval=1h&startTime=${cur}&endTime=${en}&limit=1500`;
    const r=await fetch(u); if(!r.ok){ break; } const j=await r.json(); if(!Array.isArray(j)||!j.length) break;
    acc.push(...j.map(k=>[Math.floor(k[0]/3600000),Number(k[4])]));
    const last=j[j.length-1][0]; if(last<=cur) break; cur=last+3600000; if(j.length<1500) break;
  }
  if(acc.length) { out[c]=acc; process.stdout.write(`${c}:${acc.length} `); }
}
fs.writeFileSync("hlc-skept-px-bin.json",JSON.stringify(out));
console.log("\nмонет с ценой:",Object.keys(out).length);
