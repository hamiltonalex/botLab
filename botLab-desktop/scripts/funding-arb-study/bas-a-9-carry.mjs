import { all, YEAR, openPosition, accrueFromRows, closePosition } from "./skept-cap-lib.mjs";
const COINS=["HYPE","BTC","ETH","SOL","ZEC","PUMP","ENA","XPL"];
const CAP=1e6;
console.log("coin   rows   hlCarry_short_$ on $1M   apr%   (engine config B, dPnlHl only)");
const out={};
for (const t of COINS){
  const rows=all.get(t); if(!rows){console.log(t,"NO DATA");continue;}
  const p=openPosition({strategy:"two",instrumentKey:t,config:"B",capital:CAP,leverage:1,nowMs:rows[0].tsHour*1000,roundTripCost:0});
  accrueFromRows(p,rows,rows[rows.length-1].tsHour*1000+3600000);
  closePosition(p,rows[rows.length-1].tsHour*1000+3600000);
  const hl=p.accruals.reduce((s,a)=>s+a.dPnlHl,0);
  const yrs=rows.length/8760;
  out[t]={rows:rows.length, hl, apr:hl/CAP/yrs};
  console.log(`${t.padEnd(6)} ${String(rows.length).padStart(5)} ${hl.toFixed(0).padStart(12)} ${(100*hl/CAP/yrs).toFixed(2).padStart(8)}%`);
}
import fs from "node:fs"; fs.writeFileSync("bas-a-carry.json",JSON.stringify(out,null,1));
