import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs"; import path from "node:path";
const ENG = "../../src/engine";
export const { parseSpreadCsv } = await import(`${ENG}/format.js`);
export const { scanTwoLeg, annualizeRow, mean, median } = await import(`${ENG}/math.js`);
export const { DEFAULT_COSTS, roundTripCost } = await import(`${ENG}/costs.js`);
export const { openPosition, accrueFromRows, closePosition, positionSummary, legModel } = await import(`${ENG}/paper.js`);
export const CACHE = "/Users/alexhamilton/GITFILES/hamiltonalex/funding-rate-arbitrage-backtesting/gmx_carry_backtest/spread_cache";
export const SP = STUDY_DATA;
export const YEAR = 8761;
export const all = new Map();
for (const f of fs.readdirSync(CACHE).filter((f) => f.endsWith(".csv") && !f.startsWith("_")))
  all.set(f.replace(/_\d+_\d+\.csv$/, ""), parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8")));
export const y2 = new Map();
try { for (const f of fs.readdirSync(`${SP}/y2`).filter((f)=>f.endsWith(".csv")))
  y2.set(f.replace(/\.csv$/,""), parseSpreadCsv(fs.readFileSync(path.join(SP,"y2",f),"utf8"))); } catch {}
export const pc = (x, d=2) => (x >= 0 ? "+" : "") + (100 * x).toFixed(d) + "%";
export function q(a, p){ const s=[...a].sort((x,y)=>x-y); if(!s.length) return NaN; const i=(s.length-1)*p; const lo=Math.floor(i),hi=Math.ceil(i); return s[lo]+(s[hi]-s[lo])*(i-lo); }
// Прогон ноги HL движком: возвращает {dHl, dGmx, hours, ddHl}
export function runLeg(rows, config, notional=10000, mapRow=null){
  const rr = mapRow ? rows.map(mapRow) : rows;
  const t0 = rr[0].tsHour*1000, tEnd = rr[rr.length-1].tsHour*1000+3600000;
  const p = openPosition({strategy:"two", instrumentKey:"X", config, capital:notional, leverage:1, nowMs:t0, roundTripCost:0});
  accrueFromRows(p, rr, tEnd); closePosition(p, tEnd);
  let dHl=0, dGmx=0, cum=0, peak=0, dd=0, n=0;
  for(const a of p.accruals){ dHl+=a.dPnlHl||0; dGmx+=a.dPnlGmx||0; cum+=a.dPnlHl||0; if(cum>peak)peak=cum; if(cum-peak<dd)dd=cum-peak; n++; }
  return {dHl,dGmx,hours:n,ddHl:dd,summary:positionSummary(p),accruals:p.accruals};
}
export async function hlInfo(body){
  const r = await fetch("https://api.hyperliquid.xyz/info",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(!r.ok) throw new Error("hl "+r.status); return r.json();
}
export const spearman = (a,b)=>{ const rk=(v)=>{const idx=v.map((x,i)=>[x,i]).sort((p,q)=>p[0]-q[0]); const r=new Array(v.length); let i=0; while(i<idx.length){let j=i; while(j+1<idx.length&&idx[j+1][0]===idx[i][0])j++; const avg=(i+j)/2+1; for(let k=i;k<=j;k++) r[idx[k][1]]=avg; i=j+1;} return r;};
  const ra=rk(a), rb=rk(b); const n=a.length; const ma=ra.reduce((s,x)=>s+x,0)/n, mb=rb.reduce((s,x)=>s+x,0)/n;
  let num=0,da=0,db=0; for(let i=0;i<n;i++){num+=(ra[i]-ma)*(rb[i]-mb); da+=(ra[i]-ma)**2; db+=(rb[i]-mb)**2;} return num/Math.sqrt(da*db); };
