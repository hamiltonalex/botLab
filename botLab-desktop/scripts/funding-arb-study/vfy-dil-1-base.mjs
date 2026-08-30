import fs from "node:fs";
import { all, YEAR, SP } from "./skept-cap-lib.mjs";
const CLEAN = ["AAVE","ADA","ARB","AVAX","BNB","BTC","DOGE","DOT","ENA","ETH","FARTCOIN","GMX","HYPE",
  "LINK","LTC","PENDLE","PENGU","PEPE","SEI","SOL","SUI","S","TAO","TRX","UNI","VIRTUAL","XLM","XRP"];
const med = (a) => { const s=[...a].sort((x,y)=>x-y); return s.length? s[Math.floor(s.length/2)] : NaN; };

console.log("token | flagTrue_h | medBaseL $ | medBaseS $ | minSide $ | p05 minSide $ | identRelErr med | identRelErr max");
let allErr = [];
let flagTrueTokens = [];
for (const t of CLEAN) {
  const p = `${SP}/truth-a-oi2/${t}.json`;
  const d = JSON.parse(fs.readFileSync(p, "utf8")).oi;
  const rows = all.get(t);
  const byTs = new Map(rows.map(r=>[r.tsHour,r]));
  let flagTrue = 0; const bl=[], bs=[], mn=[], err=[];
  for (const r of d) {
    if (r.useOpenInterestInTokensForBalance) flagTrue++;
    const L = Number(r.longFundingBalanceOiUsd)/1e30, S = Number(r.shortFundingBalanceOiUsd)/1e30;
    bl.push(L); bs.push(S); mn.push(Math.min(L,S));
    const row = byTs.get(Number(r.snapshotTimestamp));
    if (!row) continue;
    const a = Math.abs(row.f_long)*L, b = Math.abs(row.f_short)*S;
    const den = Math.max(a,b);
    if (den > 0) err.push(Math.abs(a-b)/den);
  }
  err.sort((x,y)=>x-y); mn.sort((x,y)=>x-y);
  if (flagTrue) flagTrueTokens.push(`${t}:${flagTrue}`);
  allErr = allErr.concat(err);
  console.log([t, flagTrue, med(bl).toExponential(2), med(bs).toExponential(2),
    med(mn).toExponential(2), mn[Math.floor(mn.length*0.05)].toExponential(2),
    (med(err)*100).toExponential(2)+"%", (err[err.length-1]*100).toExponential(2)+"%"].join(" | "));
}
allErr.sort((a,b)=>a-b);
console.log(`\nвсего часов сверено: ${allErr.length}; медиана отн.ошибки тождества ${(med(allErr)*100).toExponential(2)}%, p99 ${(allErr[Math.floor(allErr.length*0.99)]*100).toExponential(2)}%, max ${(allErr[allErr.length-1]*100).toExponential(2)}%`);
console.log(`рынки с useOpenInterestInTokensForBalance=true: ${flagTrueTokens.length? flagTrueTokens.join(", ") : "НЕТ НИ ОДНОГО"}`);
