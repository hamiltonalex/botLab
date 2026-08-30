// Проверка механизма ставки HL: ставка = формула от премии, а не делёж котла.
// Гипотеза HL: f = premium + clamp(i - premium, -0.05%, +0.05%), i = 0.01%/8ч = 1.25e-5/ч.
import fs from "node:fs"; import path from "node:path";
import { parseSpreadCsv, median, CACHE, SP } from "./skept-cap-lib.mjs";
const I = 1.25e-5, CL = 5e-4;
const model = p => p + Math.max(-CL, Math.min(CL, I - p));
let nAll=0, nFit=0, worst=0, atFloor=0, clampLo=0, clampHi=0, inBand=0;
const rows2=[];
for (const f of fs.readdirSync(CACHE).filter(f=>f.endsWith(".csv") && !f.startsWith("_"))) {
  const t = f.replace(/_\d+_\d+\.csv$/,"");
  const rows = parseSpreadCsv(fs.readFileSync(path.join(CACHE,f),"utf8"));
  let n=0, fit=0, w=0, fl=0;
  for (const r of rows) {
    if (!Number.isFinite(r.hl_rate) || !Number.isFinite(r.hl_premium)) continue;
    n++; nAll++;
    const m = model(r.hl_premium), d = Math.abs(m - r.hl_rate);
    if (d < 1e-9) { fit++; nFit++; }
    if (d > w) w = d;
    if (Math.abs(r.hl_rate - I) < 1e-12) { fl++; atFloor++; }
    if (I - r.hl_premium < -CL) clampHi++; else if (I - r.hl_premium > CL) clampLo++; else inBand++;
  }
  if (w>worst) worst=w;
  rows2.push({t, n, fit: fit/n, worst: w, floor: fl/n});
}
rows2.sort((a,b)=>a.fit-b.fit);
console.log("совпадение ставки с формулой premium+clamp(i-premium,+-0.05%): "+(100*nFit/nAll).toFixed(3)+"% из "+nAll+" часов, макс.невязка "+worst.toExponential(2));
console.log("часов ровно на i=1.25e-5 (нулевая премия по клампу): "+(100*atFloor/nAll).toFixed(2)+"%");
console.log("режимы: клампом СНИЗУ(премия>i+0.05%, шорт получает премию) "+(100*clampHi/nAll).toFixed(2)+"% ; клампом СВЕРХУ(премия<i-0.05%) "+(100*clampLo/nAll).toFixed(2)+"% ; внутри полосы (ставка=i) "+(100*inBand/nAll).toFixed(2)+"%");
console.log("худшие 6 монет по совпадению:"); for (const r of rows2.slice(0,6)) console.log(`  ${r.t} fit=${(100*r.fit).toFixed(2)}% worst=${r.worst.toExponential(2)} floor=${(100*r.floor).toFixed(1)}%`);
