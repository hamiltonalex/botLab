import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP=STUDY_DATA;
const ENG="/Users/alexhamilton/GITFILES/hamiltonalex/botLab/.claude/worktrees/angry-bassi-af7631/botLab-desktop/src/engine";
const {parseSpreadCsv}=await import(`${ENG}/format.js`);
const {openPosition,accrueFromRows,closePosition,positionSummary}=await import(`${ENG}/paper.js`);
const CACHE="/Users/alexhamilton/GITFILES/hamiltonalex/funding-rate-arbitrage-backtesting/gmx_carry_backtest/spread_cache";
const files=fs.readdirSync(CACHE).filter(f=>f.endsWith(".csv")&&!f.startsWith("_"));
const want=["HYPE","BTC","ETH","SOL"];
const CAP=100000;
for(const t of want){
 const f=files.find(x=>x.replace(/_\d+_\d+\.csv$/,"")===t); if(!f){console.log(t,"NOT IN CACHE");continue;}
 const rows=parseSpreadCsv(fs.readFileSync(`${CACHE}/${f}`,"utf8"));
 const p=openPosition({strategy:"two",instrumentKey:t,config:"B",capital:CAP,leverage:1,nowMs:rows[0].tsHour*1000,roundTripCost:0});
 accrueFromRows(p,rows,rows[rows.length-1].tsHour*1000+3600000);
 closePosition(p,rows[rows.length-1].tsHour*1000+3600000);
 const legHl=p.accruals.reduce((s,a)=>s+(a.dPnlHl||0),0);
 const yrs=rows.length/8760;
 // funding composition from cache
 const I=1.25e-5;
 const r=rows.map(x=>x.hl_rate).filter(Number.isFinite);
 const eq=r.filter(x=>Math.abs(x-I)<1e-12).length;
 const sum=r.reduce((s,x)=>s+x,0);
 console.log(`${t}: rows=${rows.length} legHL=$${legHl.toFixed(0)} on $${CAP} => ${(100*legHl/CAP/yrs).toFixed(2)}%/yr | rate==i exactly in ${(100*eq/r.length).toFixed(1)}% of hours | mean rate ${(sum/r.length*8760*100).toFixed(2)}%/yr (i=${(I*8760*100).toFixed(2)}%) | first=${new Date(rows[0].tsHour*1000).toISOString().slice(0,10)} last=${new Date(rows[rows.length-1].tsHour*1000).toISOString().slice(0,10)}`);
}
