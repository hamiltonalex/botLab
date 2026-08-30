import { APP as STUDY_APP } from "./paths.mjs";
import { readFileSync } from "node:fs";
const B = STUDY_APP;
const { parseSpreadCsv } = await import(`${B}/src/engine/format.js`);
const { DEFAULT_COSTS, roundTripCost } = await import(`${B}/src/engine/costs.js`);
const { openPosition, accrueFromRows, closePosition, positionSummary } = await import(`${B}/src/engine/paper.js`);
const load=(a)=>parseSpreadCsv(readFileSync(`${B}/test/fixtures/${a}.csv`,"utf8"));
const R={APT:load("APT"),BTC:load("BTC"),ETH:load("ETH")};
const CAP=2000;
const SPECS=[["APT two-A","APT","two","A"],["APT two-B","APT","two","B"],["APT one","APT","one",null],
["BTC two-A","BTC","two","A"],["BTC two-B","BTC","two","B"],["BTC one","BTC","one",null],
["ETH two-A","ETH","two","A"],["ETH two-B","ETH","two","B"],["ETH one","ETH","one",null]];
function run(spec,lev,costs=DEFAULT_COSTS){
  const [lbl,a,st,cf]=spec; const rows=R[a]; const isOne=st==="one"; const N=CAP*lev;
  const p=openPosition({strategy:st,instrumentKey:a,config:cf,capital:CAP,leverage:lev,nowMs:rows[0].tsHour*1000,roundTripCost:roundTripCost(costs,N,isOne)});
  accrueFromRows(p,rows,(rows.at(-1).tsHour+3600)*1000); closePosition(p,(rows.at(-1).tsHour+3600)*1000);
  return positionSummary(p);
}
console.log("### A. Wipeout leverage WITH the round-trip fee included (author's 1/f ignores it)");
for(const s of SPECS){
  const q=run(s,1); const f=q.maxDrawdownPct;
  // solve L: L*CAP*f + roundTripCost(L*CAP) = CAP  (fee is charged in full, dd is gross)
  let lo=0,hi=1000; const isOne=s[2]==="one";
  for(let i=0;i<200;i++){const m=(lo+hi)/2; const loss=m*CAP*f+roundTripCost(DEFAULT_COSTS,m*CAP,isOne); if(loss<CAP) lo=m; else hi=m;}
  console.log(`  ${s[0].padEnd(10)} f=${(100*f).toFixed(4)}%  author 1/f = ${(1/f).toFixed(2)}x   fee-inclusive = ${lo.toFixed(2)}x`);
}
console.log("\n### B. Decomposing the 2.66% -> 1.38% drop (which half is gas, which is rotations)");
const honest={...DEFAULT_COSTS,gmxGas:2.0};
const impactBoth={...DEFAULT_COSTS,gmxGas:2.0,gmxImpact:0.2}; // impact is charged on entry AND exit
for(const s of [SPECS[4],SPECS[6]]){
  const g=run(s,1).grossPnl; const N=2000;
  const c=roundTripCost(DEFAULT_COSTS,N,false), ch=roundTripCost(honest,N,false), ci=roundTripCost(impactBoth,N,false);
  const P=(x)=>(100*x/CAP).toFixed(3)+"%";
  console.log(`  ${s[0]}: gross ${P(g)}`);
  console.log(`     default rt $${c.toFixed(2)}: 1rt ${P(g-c)}  4rt ${P(g-4*c)}  8rt ${P(g-8*c)}   budget ${(g/c).toFixed(2)}`);
  console.log(`     gas x2  rt $${ch.toFixed(2)}: 1rt ${P(g-ch)}  4rt ${P(g-4*ch)}  8rt ${P(g-8*ch)}   budget ${(g/ch).toFixed(2)}`);
  console.log(`     gas x2 + impact both sides rt $${ci.toFixed(2)}: 1rt ${P(g-ci)}  4rt ${P(g-4*ci)}  8rt ${P(g-8*ci)}   budget ${(g/ci).toFixed(2)}`);
  console.log(`     if "4 rotations" means 4 SWITCHES (=5 positions), gas x2: ${P(g-5*ch)}`);
}
console.log("\n### C. Is the '8 round trips' budget a property of the strategy or of the token's carry?");
for(const s of SPECS){ const q=run(s,1); const isOne=s[2]==="one"; const c=roundTripCost(DEFAULT_COSTS,2000,isOne);
  console.log(`  ${s[0].padEnd(10)} grossAPR ${(100*q.grossPnl/CAP).toFixed(3).padStart(9)}%  budget ${q.grossPnl>0?(q.grossPnl/c).toFixed(2).padStart(7):"   n/a"} rt/yr`);}
console.log("\n### D. Same table at other capital sizes: does the '8 rounds' budget move with size?");
for(const cap of [100,2000,100000]){
  const g=run(SPECS[4],1).grossPnl*(cap/2000);
  const c=roundTripCost(DEFAULT_COSTS,cap,false);
  console.log(`  BTC two-B, $${String(cap).padStart(6)}: gross $${g.toFixed(2)} rt $${c.toFixed(2)} budget ${(g/c).toFixed(2)} rt/yr`);
}
