import {q,MAP,all,SP,apr} from "./truth-v-lib.mjs"; import fs from "node:fs";
const cap=JSON.parse(fs.readFileSync(`${SP}/truth-v-cap.json`,"utf8"));
const capBy=new Map(cap.map(r=>[r.t,r]));
// сверка масштаба: снимки из источника против кэша, на трёх токенах
for(const t of ["BTC","ETH","BOME","FET","S"]){
  const a=MAP.get(t).market; const rows=all.get(t);
  const mid=rows[Math.floor(rows.length*0.5)];
  const d=await q(`{ fundingRateSnapshots(limit:3, where:{marketAddress_eq:"${a}", snapshotTimestamp_gte:${mid.tsHour-1800}, snapshotTimestamp_lte:${mid.tsHour+1800}}, orderBy: snapshotTimestamp_ASC){ snapshotTimestamp fundingFactorPerSecondLong fundingFactorPerSecondShort } }`);
  const c=capBy.get(t);
  console.log(`\n${t}  час кэша ${mid.ts}`);
  console.log(`  кэш   f_long=${mid.f_long.toExponential(6)}  f_short=${mid.f_short.toExponential(6)}`);
  for(const s of d.fundingRateSnapshots)
    console.log(`  источник ts=${new Date(s.snapshotTimestamp*1000).toISOString()} L=${(Number(s.fundingFactorPerSecondLong)/1e30).toExponential(6)} S=${(Number(s.fundingFactorPerSecondShort)/1e30).toExponential(6)}`);
  console.log(`  marketInfos СЕЙЧАС: fundingFactorPerSecond=${(Number(c.fundingFactorPerSecond)/1e30).toExponential(4)} longsPayShorts=${c.longsPayShorts} maxFFPS=${(Number(c.maxFundingFactorPerSecondLong)/1e30).toExponential(4)} fundingUpdatedAt=${new Date(c.fundingUpdatedAt*1000).toISOString()}`);
}
