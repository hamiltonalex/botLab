// Сверка: движок против прямой суммы ставок; симметрия конфигов A/B; полнота начислений.
import fs from "node:fs"; import path from "node:path";
import { parseSpreadCsv, openPosition, accrueFromRows, closePosition, positionSummary, annualizeRow, CACHE } from "./skept-cap-lib.mjs";
const CAP=10000, H=3600000;
let worstRel=0, worstT="", bad=0, n=0;
for (const f of fs.readdirSync(CACHE).filter(f=>f.endsWith(".csv")&&!f.startsWith("_"))) {
  const t=f.replace(/_\d+_\d+\.csv$/,""); const rows=parseSpreadCsv(fs.readFileSync(path.join(CACHE,f),"utf8"));
  const mk=cfg=>{const p=openPosition({strategy:"two",instrumentKey:t,config:cfg,capital:CAP,leverage:1,nowMs:rows[0].tsHour*1000,roundTripCost:0});
    accrueFromRows(p,rows,rows[rows.length-1].tsHour*1000+H); closePosition(p,rows[rows.length-1].tsHour*1000+H); return p;};
  const B=mk("B"), A=mk("A");
  const hlB=B.accruals.reduce((s,a)=>s+a.dPnlHl,0), hlA=A.accruals.reduce((s,a)=>s+a.dPnlHl,0);
  const direct=rows.reduce((s,r)=>s+(Number.isFinite(r.hl_rate)?r.hl_rate:0),0)*CAP;
  const rel=Math.abs(hlB-direct)/Math.max(1,Math.abs(direct));
  if (rel>worstRel){worstRel=rel;worstT=t;}
  if (Math.abs(hlA+hlB)>1e-6) bad++;
  if (B.accruals.length!==rows.length) { n++; if(n<4) console.log(`  ${t}: начислений ${B.accruals.length} против строк ${rows.length}`); }
  // сумма по журналу против positionSummary
  const g=positionSummary(B).grossPnl, sum=B.accruals.reduce((s,a)=>s+a.dPnl,0);
  if (Math.abs(g-sum)>1e-6) console.log(`  ${t}: grossPnl != сумма журнала`);
}
console.log(`движок против прямой суммы hl_rate: макс. отн. расхождение ${worstRel.toExponential(2)} (${worstT})`);
console.log(`нарушений симметрии A=-B: ${bad}; монет с неполным журналом: ${n}`);
// одна монета детально
const rows=parseSpreadCsv(fs.readFileSync(path.join(CACHE,"BTC_1750402800_1781938800.csv"),"utf8"));
const p=openPosition({strategy:"two",instrumentKey:"BTC",config:"B",capital:CAP,leverage:1,nowMs:rows[0].tsHour*1000,roundTripCost:0});
accrueFromRows(p,rows,rows[rows.length-1].tsHour*1000+H);
const hl=p.accruals.reduce((s,a)=>s+a.dPnlHl,0), st=p.accruals.reduce((s,a)=>s+a.hlSettlements,0);
console.log(`BTC: часов ${rows.length}, начислений ${p.accruals.length}, HL-расчётов ${st}, dPnlHl итого $${hl.toFixed(2)} = ${(100*hl/CAP).toFixed(2)}% за ${(rows.length/8760).toFixed(3)} года`);
console.log(`BTC: annualizeRow средняя hl_short_recv ${(100*rows.map(annualizeRow).reduce((s,r)=>s+r.hl_short_recv,0)/rows.length).toFixed(2)}% год.`);
