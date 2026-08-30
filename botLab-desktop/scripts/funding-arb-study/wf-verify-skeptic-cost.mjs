import { APP as STUDY_APP } from "./paths.mjs";
// Independent re-derivation. Different construction from the author's:
//  - gross from the MATH path (annualizeRow/scan*/pnlPath) instead of the paper ledger
//  - rotation cut by TIMESTAMPS (incl. mid-hour cuts), not by row-index slices
//  - breakeven multiplier by BISECTION on the real roundTripCost, not a closed form
import { readFileSync } from "node:fs";
const B = STUDY_APP;
const { parseSpreadCsv } = await import(`${B}/src/engine/format.js`);
const { scanTwoLeg, scanOneLeg, pnlPath, maxDrawdownFraction, annualizeRow, HOURS_PER_YEAR } = await import(`${B}/src/engine/math.js`);
const { DEFAULT_COSTS, roundTripCost, roundTripCostBreakdown, normalizeCosts } = await import(`${B}/src/engine/costs.js`);
const { openPosition, accrueFromRows, closePosition, positionSummary, accountSummary } = await import(`${B}/src/engine/paper.js`);

const load = (a) => parseSpreadCsv(readFileSync(`${B}/test/fixtures/${a}.csv`, "utf8"));
const R = { APT: load("APT"), BTC: load("BTC"), ETH: load("ETH") };
const CAP = 2000, LEV = 1, N = CAP * LEV;
const SPECS = [];
for (const a of ["APT","BTC","ETH"]) {
  SPECS.push({label:`${a} two-A`, asset:a, strategy:"two", config:"A"});
  SPECS.push({label:`${a} two-B`, asset:a, strategy:"two", config:"B"});
  SPECS.push({label:`${a} one`,   asset:a, strategy:"one", config:null});
}

console.log("### 1. GROSS: paper ledger vs INDEPENDENT math path (annualizeRow -> pnlPath)");
const grossPaper = {}, grossMath = {};
for (const s of SPECS) {
  const rows = R[s.asset];
  const isOne = s.strategy === "one";
  const p = openPosition({strategy:s.strategy, instrumentKey:s.asset, config:s.config, capital:CAP, leverage:LEV,
    nowMs: rows[0].tsHour*1000, roundTripCost: roundTripCost(DEFAULT_COSTS, N, isOne)});
  const ap = accrueFromRows(p, rows, (rows.at(-1).tsHour+3600)*1000);
  closePosition(p, (rows.at(-1).tsHour+3600)*1000);
  const q = positionSummary(p);
  grossPaper[s.label] = q.grossPnl;
  // independent: math.js series
  let series;
  if (isOne) series = scanOneLeg(rows, {token:s.asset}).net;
  else { const t = scanTwoLeg(rows, {token:s.asset}); series = s.config === "A" ? t.seriesA : t.seriesB; }
  const pp = pnlPath(series, N);
  grossMath[s.label] = pp.total;
  console.log(`${s.label.padEnd(10)} paper $${q.grossPnl.toFixed(4).padStart(11)}  math $${pp.total.toFixed(4).padStart(11)}  diff $${(q.grossPnl-pp.total).toExponential(3)}  h=${ap.hoursApplied} gap=${ap.gapSkippedSec}s hoursElapsed=${q.hoursElapsed}`);
}

console.log("\n### 2. Round-trip cost identity: breakdown sum == roundTripCost, and the m-linearity the author assumed");
const scale = (m) => ({gmxOpen:DEFAULT_COSTS.gmxOpen*m, gmxClose:DEFAULT_COSTS.gmxClose*m, gmxImpact:DEFAULT_COSTS.gmxImpact*m, gmxGas:DEFAULT_COSTS.gmxGas*m, hlTaker:DEFAULT_COSTS.hlTaker*m, hlSides:DEFAULT_COSTS.hlSides});
for (const isOne of [false,true]) {
  const b = roundTripCostBreakdown(DEFAULT_COSTS, N, isOne);
  const sum = Object.values(b).reduce((a,x)=>a+x,0);
  console.log(`  ${isOne?"one":"two"}-leg: sum(breakdown)=$${sum.toFixed(6)} roundTripCost=$${roundTripCost(DEFAULT_COSTS,N,isOne).toFixed(6)}`);
}
for (const m of [0.5,2,8.39,20]) {
  const c = roundTripCost(scale(m), N, false), c1 = roundTripCost(DEFAULT_COSTS, N, false);
  console.log(`  m=${m}: rt=$${c.toFixed(6)} vs m*rt(1)=$${(m*c1).toFixed(6)} -> linear? ${Math.abs(c-m*c1)<1e-9}`);
}

console.log("\n### 3. Breakeven multiplier by BISECTION on the real roundTripCost (no closed form)");
for (const lbl of ["BTC two-B","ETH two-A","ETH one","APT two-A"]) {
  const s = SPECS.find(x=>x.label===lbl), isOne = s.strategy==="one";
  const g = grossPaper[lbl];
  let lo=0, hi=1000;
  for (let i=0;i<300;i++){const mid=(lo+hi)/2; if (g - roundTripCost(scale(mid), N, isOne) > 0) lo=mid; else hi=mid;}
  console.log(`  ${lbl.padEnd(10)} gross $${g.toFixed(4)}  m* = ${lo.toFixed(4)}  (author closed form ${(g/roundTripCost(DEFAULT_COSTS,N,isOne)).toFixed(4)})`);
}

console.log("\n### 4. ROTATION rebuilt on TIMESTAMP cuts (incl. deliberate MID-HOUR cuts)");
// cut the year into k equal TIME slices; positions open/close at exact ms, not row indices.
function rotateByTime(rows, s, k, offsetSec = 0) {
  const isOne = s.strategy === "one";
  const t0 = rows[0].tsHour*1000, tEnd = (rows.at(-1).tsHour+3600)*1000;
  const span = tEnd - t0;
  const cuts = [t0];
  for (let i=1;i<k;i++) cuts.push(t0 + Math.round(span*i/k) + offsetSec*1000);
  cuts.push(tEnd);
  const positions = [];
  for (let i=0;i<k;i++) {
    const a = cuts[i], b = cuts[i+1];
    const p = openPosition({strategy:s.strategy, instrumentKey:s.asset, config:s.config, capital:CAP, leverage:LEV,
      nowMs:a, roundTripCost: roundTripCost(DEFAULT_COSTS, N, isOne)});
    accrueFromRows(p, rows.filter(r=>r.tsHour*1000+3600000 > a && r.tsHour*1000 < b), b);
    closePosition(p, b);
    positions.push(p);
  }
  const acc = accountSummary(positions);
  const hours = positions.reduce((x,p)=>x+p.accruals.length,0);
  const secs = positions.reduce((x,p)=>x+p.accruals.reduce((y,a)=>y+(a.dtSec||0),0),0);
  return {k:positions.length, gross:acc.grossPnl, net:acc.netPnl, gap:acc.gapSkippedSec, hours, secs};
}
for (const lbl of ["BTC two-B","ETH two-A","APT two-A","ETH one"]) {
  const s = SPECS.find(x=>x.label===lbl);
  console.log(`  -- ${lbl} (single-position gross $${grossPaper[lbl].toFixed(4)}) --`);
  for (const [k,off] of [[1,0],[4,0],[12,0],[52,0],[365,0],[4,1800],[12,1800],[52,1800],[12,900],[12,-1234]]) {
    const o = rotateByTime(R[s.asset], s, k, off);
    console.log(`    k=${String(k).padStart(3)} off=${String(off).padStart(6)}s: gross $${o.gross.toFixed(4).padStart(11)} (dGross ${(o.gross-grossPaper[lbl]).toExponential(2)}) net $${o.net.toFixed(2).padStart(10)} secsAccrued=${o.secs} (expect ${8761*3600}) gapSec=${o.gap}`);
  }
}

console.log("\n### 5. Author's index-slice rotation: does k actually produce k positions?");
function rotateIdx(rows, s, k) {
  const isOne = s.strategy==="one"; const per = Math.ceil(rows.length/k); const ps=[];
  for (let i=0;i<rows.length;i+=per) {
    const seg = rows.slice(i, Math.min(rows.length, i+per));
    const p = openPosition({strategy:s.strategy, instrumentKey:s.asset, config:s.config, capital:CAP, leverage:LEV,
      nowMs:seg[0].tsHour*1000, roundTripCost: roundTripCost(DEFAULT_COSTS, N, isOne)});
    accrueFromRows(p, seg, (seg.at(-1).tsHour+3600)*1000); closePosition(p,(seg.at(-1).tsHour+3600)*1000); ps.push(p);
  }
  const acc = accountSummary(ps);
  return {asked:k, got:ps.length, gross:acc.grossPnl, net:acc.netPnl};
}
for (const k of [1,2,4,6,8,12,52,365]) {
  const o = rotateIdx(R.BTC, SPECS.find(x=>x.label==="BTC two-B"), k);
  console.log(`  asked k=${String(k).padStart(3)} -> got ${String(o.got).padStart(3)} positions  net $${o.net.toFixed(2)}  (net if truly k rt = $${(o.gross - k*roundTripCost(DEFAULT_COSTS,N,false)).toFixed(2)})`);
}

console.log("\n### 6. Drawdown: positionSummary.maxDrawdownPct vs math.js maxDrawdownFraction");
for (const s of SPECS) {
  const rows = R[s.asset], isOne = s.strategy==="one";
  const p = openPosition({strategy:s.strategy, instrumentKey:s.asset, config:s.config, capital:CAP, leverage:LEV, nowMs:rows[0].tsHour*1000, roundTripCost:0});
  accrueFromRows(p, rows, (rows.at(-1).tsHour+3600)*1000); closePosition(p,(rows.at(-1).tsHour+3600)*1000);
  const q = positionSummary(p);
  let series; if (isOne) series = scanOneLeg(rows,{token:s.asset}).net; else { const t=scanTwoLeg(rows,{token:s.asset}); series = s.config==="A"?t.seriesA:t.seriesB; }
  const f = maxDrawdownFraction(series);
  console.log(`  ${s.label.padEnd(10)} paper ddPct ${(100*q.maxDrawdownPct).toFixed(4)}%  math ddFraction ${(100*f).toFixed(4)}%  wipeout lev ${(1/q.maxDrawdownPct).toFixed(2)}x`);
}

console.log("\n### 7. Small-sample / boundary token: truncate to 30 and 23 rows");
for (const n of [30, 23]) {
  const rows = R.BTC.slice(0, n);
  const p = openPosition({strategy:"two", instrumentKey:"BTC", config:"B", capital:CAP, leverage:LEV, nowMs:rows[0].tsHour*1000, roundTripCost:roundTripCost(DEFAULT_COSTS,N,false)});
  const ap = accrueFromRows(p, rows, (rows.at(-1).tsHour+3600)*1000); closePosition(p,(rows.at(-1).tsHour+3600)*1000);
  const q = positionSummary(p);
  console.log(`  ${n} rows: hoursApplied=${ap.hoursApplied} gross $${q.grossPnl.toFixed(4)} net $${q.netPnl.toFixed(4)} apr ${(100*q.apr).toFixed(2)}% aprReliable=${q.aprReliable} scanTwoLeg=${scanTwoLeg(rows,{token:"BTC"})?"ok":"null (minRows)"}`);
}

console.log("\n### 8. Headline verdict numbers, re-derived");
const honest = {...DEFAULT_COSTS, gmxGas: 2.0};
for (const lbl of ["BTC two-B","ETH two-A"]) {
  const g = grossPaper[lbl];
  const c0 = roundTripCost(DEFAULT_COSTS,N,false), ch = roundTripCost(honest,N,false);
  console.log(`  ${lbl}: gross ${(100*g/CAP).toFixed(4)}% | 1 rt @default -> ${(100*(g-c0)/CAP).toFixed(4)}% | 4 rt @gas2 -> ${(100*(g-4*ch)/CAP).toFixed(4)}% | 8 rt @gas2 -> ${(100*(g-8*ch)/CAP).toFixed(4)}% | budget @default ${(g/c0).toFixed(3)} rt/yr, @gas2 ${(g/ch).toFixed(3)} rt/yr`);
}
