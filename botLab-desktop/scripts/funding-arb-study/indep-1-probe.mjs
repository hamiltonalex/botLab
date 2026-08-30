import { oiTokens, loadRows, loadOi, YEAR } from "./indep-lib.mjs";
let ok=0, miss=[];
for (const t of oiTokens) {
  const rows = loadRows(t); const oi = loadOi(t);
  if (!rows) { miss.push(t+":nocsv"); continue; }
  let matched=0, idErr=[], both=0, none=0;
  for (const r of rows) {
    const s = oi.get(r.tsHour); if (!s) continue; matched++;
    const L = Math.abs(r.f_long)*s.bl, S = Math.abs(r.f_short)*s.bs;
    if (L+S>0) idErr.push(Math.abs(L-S)/Math.max(L,S));
    if (r.f_long>0 && r.f_short>0) both++;
    if (r.f_long<=0 && r.f_short<=0) none++;
  }
  idErr.sort((a,b)=>a-b);
  const p99 = idErr.length? idErr[Math.floor(idErr.length*0.99)] : NaN;
  const mx = idErr.length? idErr[idErr.length-1] : NaN;
  console.log(`${t.padEnd(9)} rows=${rows.length} matched=${matched} idP99=${(100*p99).toExponential(2)}% idMax=${(100*mx).toExponential(2)}% bothPos=${both} nonePos=${none}`);
  ok++;
}
console.log("tokens ok", ok, "miss", miss.join(","));
