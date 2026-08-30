import fs from "node:fs"; import path from "node:path";
import { parseSpreadCsv, median, CACHE } from "./skept-cap-lib.mjs";
const I = 1.25e-5, CL = 5e-4;
const model = p => p + Math.max(-CL, Math.min(CL, I - p));
let n=0, fitTol=0, inBandRate=0, inBandBoth=0, sx=0,sy=0,sxx=0,sxy=0,syy=0, mn=1e9, mx=-1e9, mnp=1e9,mxp=-1e9;
const err=[];
for (const f of fs.readdirSync(CACHE).filter(f=>f.endsWith(".csv") && !f.startsWith("_"))) {
  for (const r of parseSpreadCsv(fs.readFileSync(path.join(CACHE,f),"utf8"))) {
    const {hl_rate:y, hl_premium:p} = r; if (!Number.isFinite(y)||!Number.isFinite(p)) continue;
    n++; const m = model(p); const d = y-m; err.push(Math.abs(d));
    if (Math.abs(d) < 2e-5) fitTol++;
    if (Math.abs(y-I)<1e-12) { inBandRate++; if (Math.abs(I-p)<=CL) inBandBoth++; }
    sx+=p; sy+=y; sxx+=p*p; sxy+=p*y; syy+=y*y;
    if(y<mn)mn=y; if(y>mx)mx=y; if(p<mnp)mnp=p; if(p>mxp)mxp=p;
  }
}
const cov=sxy/n-(sx/n)*(sy/n), vx=sxx/n-(sx/n)**2, vy=syy/n-(sy/n)**2;
console.log(`часов ${n}; совпадение с формулой в допуске 2e-5: ${(100*fitTol/n).toFixed(2)}%; медиана |невязки| ${median(err).toExponential(2)}`);
console.log(`когда ставка ровно = i, премия внутри полосы в ${(100*inBandBoth/inBandRate).toFixed(2)}% случаев`);
console.log(`corr(премия,ставка)=${(cov/Math.sqrt(vx*vy)).toFixed(4)}  наклон=${(cov/vx).toFixed(4)}`);
console.log(`ставка мин ${mn.toExponential(3)} (${(mn*8760*100).toFixed(0)}% год.) макс ${mx.toExponential(3)} (${(mx*8760*100).toFixed(0)}% год.)`);
console.log(`премия мин ${mnp.toExponential(3)} макс ${mxp.toExponential(3)}`);
