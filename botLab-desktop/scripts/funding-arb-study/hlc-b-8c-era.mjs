import { SP, parseSpreadCsv } from "./skept-cap-lib.mjs";
import fs from "node:fs";
const I=1e-4,K=8; const f=(p,C)=>(p+Math.max(-C,Math.min(C,I-p)))/K;
const rows=[]; for (const file of fs.readdirSync(`${SP}/y2`).filter(x=>x.endsWith(".csv")))
  for (const r of parseSpreadCsv(fs.readFileSync(`${SP}/y2/${file}`,"utf8")))
    if(Number.isFinite(r.hl_rate)&&Number.isFinite(r.hl_premium)) rows.push(r);
const day = (r)=>String(r.ts).slice(0,10);
function fit(sub,C){let bad=0;for(const r of sub) if(Math.abs(r.hl_rate-f(r.hl_premium,C))>1e-10)bad++;return bad/sub.length;}
for (const C of [3e-4,4e-4,5e-4]) {
  const a=rows.filter(r=>day(r)<"2024-01-01"), b=rows.filter(r=>day(r)>="2024-01-01");
  console.log(`C=${C}: доля несовпадений до 2024-01-01 (${a.length} ч) = ${(100*fit(a,C)).toFixed(3)}%,  после (${b.length} ч) = ${(100*fit(b,C)).toFixed(3)}%`);
}
// день перелома
const days=[...new Set(rows.map(day))].sort();
let prev=null;
for (const d of days) {
  const s=rows.filter(r=>day(r)===d); if(s.length<50) continue;
  const c3=fit(s,3e-4), c5=fit(s,5e-4); const w=c3<c5?"3e-4":"5e-4";
  if (prev && prev!==w) console.log(`  перелом клампа: ${d} (было ${prev}, стало ${w})`);
  prev=w;
}
