import fs from "node:fs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30=1e30,YR=3600*8760;
const oi=new Map(JSON.parse(fs.readFileSync("truth-b-raw/oi_BOME.json","utf8"))
  .map(r=>[Math.floor(r.snapshotTimestamp/3600)*3600,{L:Number(r.longOpenInterestUsd)/E30,S:Number(r.shortOpenInterestUsd)/E30}]));
const rows=cacheRows("BOME").map(r=>({...r,h:Math.floor(Date.parse(r.ts.replace(" ","T"))/1000/3600)*3600}));
const V=-2.252130017193753e-8;
const w=rows.filter(r=>Math.abs(+r.f_long-V)<1e-20);
console.log(`BOME: часов с залипшим f_long = ${V}: ${w.length}`);
console.log(`окно ${w[0].ts} .. ${w[w.length-1].ts}`);
const L=w.map(r=>oi.get(r.h)?.L).filter(x=>x!=null), S=w.map(r=>oi.get(r.h)?.S).filter(x=>x!=null);
const uL=new Set(L.map(x=>x.toFixed(6))), uS=new Set(S.map(x=>x.toFixed(6)));
console.log(`  OI лонгов в этом окне: ${uL.size} разных значений, диапазон $${Math.min(...L).toFixed(2)}..$${Math.max(...L).toFixed(2)}`);
console.log(`  OI шортов в этом окне: ${uS.size} разных значений, диапазон $${Math.min(...S).toFixed(2)}..$${Math.max(...S).toFixed(2)}`);
console.log(`  f_short в этом окне: ${new Set(w.map(r=>r.f_short)).size} разных значений`);
console.log(`  ставка ${V} = ${(Math.abs(V)*YR*100).toFixed(1)}% годовых; долларов в час = $${(Math.abs(V)*Math.max(...L)*3600).toFixed(6)}`);
console.log(`\n  минимальный протокольный фактор minFundingFactorPerSecond = 317097919837645865043/1e30 = ${(317097919837645865043/1e30).toExponential(3)}/с = ${(317097919837645865043/1e30*YR*100).toFixed(1)}% годовых`);
