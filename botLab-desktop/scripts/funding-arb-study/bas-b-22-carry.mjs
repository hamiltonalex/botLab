import { all, openPosition, accrueFromRows, closePosition, positionSummary, YEAR } from "./skept-cap-lib.mjs";
for(const t of ["HYPE","BTC","ETH"]){
  const rows=all.get(t); if(!rows){console.log(t,"нет данных");continue}
  const p=openPosition({strategy:"two",instrumentKey:t,config:"B",capital:100000,leverage:1,nowMs:rows[0].tsHour*1000,roundTripCost:0});
  accrueFromRows(p,rows,rows[rows.length-1].tsHour*1000+3600000);
  closePosition(p,rows[rows.length-1].tsHour*1000+3600000);
  const s=positionSummary(p);
  const hl=p.accruals.reduce((a,x)=>a+(x.dPnlHl||0),0);
  console.log(t,"часов",rows.length,"grossPnl",s.grossPnl.toFixed(2),"вклад ноги HL",hl.toFixed(2),"= ",(100*hl/100000).toFixed(2)+"% годовых на $100k");
}
