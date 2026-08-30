// Из чего складывается totalImpactUsd и что он значит на увеличении/уменьшении в нынешнем режиме.
import fs from "node:fs";
import { SP, URL_ARB, E30, gql, marketMap } from "./imp-gmx-lib.mjs";
const M=marketMap(); const POST=1759276800, T1=1781938800;
const F="id orderType sizeDeltaUsd priceImpactUsd priceImpactDiffUsd proportionalPendingImpactUsd totalImpactUsd isLong timestamp";
for(const t of ["BTC","SOL","LINK","DOGE"]){
  const a=M.get(t).addr;
  for(const [lbl,types] of [["УВЕЛИЧЕНИЕ",[2,3]],["УМЕНЬШЕНИЕ",[4,5]]]){
    const d=await gql(URL_ARB,`{ tradeActions(limit:400, orderBy: timestamp_ASC, where:{marketAddress_eq:"${a}", eventName_eq:"OrderExecuted", sizeDeltaUsd_gt:"0", timestamp_gte:${POST}, timestamp_lte:${T1}, orderType_in:[${types}]}){ ${F} } }`);
    const rows=d.tradeActions.map(r=>({sz:+r.sizeDeltaUsd/E30, pi:+r.priceImpactUsd/E30,
      pd:r.priceImpactDiffUsd==null?0:+r.priceImpactDiffUsd/E30,
      pp:r.proportionalPendingImpactUsd==null?0:+r.proportionalPendingImpactUsd/E30,
      ti:r.totalImpactUsd==null?null:+r.totalImpactUsd/E30}));
    const ok=rows.filter(r=>r.ti!=null);
    const res=ok.map(r=>r.ti-(r.pi+r.pp-r.pd));
    const res2=ok.map(r=>r.ti-(r.pi+r.pp));
    const mm=xs=>{const s=xs.slice().sort((x,y)=>x-y);return s.length?s[Math.floor(s.length/2)]:NaN;};
    const nz=xs=>xs.filter(x=>Math.abs(x)>1e-9).length;
    console.log(`${t} ${lbl}: n=${rows.length}`,
      `| pi!=0 у ${nz(rows.map(r=>r.pi))}`, `| pp!=0 у ${nz(rows.map(r=>r.pp))}`, `| pd!=0 у ${nz(rows.map(r=>r.pd))}`,
      `| мед bps pi ${(1e4*mm(rows.map(r=>r.pi/r.sz))).toFixed(2)}`,
      `pp ${(1e4*mm(rows.map(r=>r.pp/r.sz))).toFixed(2)}`,
      `ti ${(1e4*mm(ok.map(r=>r.ti/r.sz))).toFixed(2)}`,
      `| остаток ti-(pi+pp-pd) макс ${Math.max(...res.map(Math.abs)).toFixed(4)} | ti-(pi+pp) макс ${Math.max(...res2.map(Math.abs)).toFixed(4)}`);
  }
}
