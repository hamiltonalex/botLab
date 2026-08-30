import {q,MAP,all,apr} from "./truth-v-lib.mjs";
// Проверка: связаны ли f_long и f_short отношением открытого интереса (пропорциональная раздача)?
for(const t of ["BOME","ORDI","PEPE","BTC","MELANIA"]){
  const a=MAP.get(t).market; const rows=all.get(t);
  const i=Math.floor(rows.length*0.75);
  const d=await q(`{ fundingBalanceOiSnapshots(limit:5, orderBy: snapshotTimestamp_ASC, where:{marketAddress_eq:"${a}", snapshotTimestamp_gte:${rows[i].tsHour}}){ snapshotTimestamp longOpenInterestUsd shortOpenInterestUsd } }`);
  const s=d.fundingBalanceOiSnapshots[0]; if(!s){console.log(t,"нет OI");continue;}
  const L=Number(s.longOpenInterestUsd)/1e30, S=Number(s.shortOpenInterestUsd)/1e30;
  const r=rows[i];
  console.log(`${t.padEnd(9)} ${r.ts.slice(0,16)}  OI_long=$${L.toFixed(0).padStart(9)} OI_short=$${S.toFixed(0).padStart(9)}  OI_L/OI_S=${(L/S).toFixed(4).padStart(9)}`);
  console.log(`          f_long=${r.f_long.toExponential(5)} f_short=${r.f_short.toExponential(5)}  |f_L|/|f_S|=${(Math.abs(r.f_long)/Math.abs(r.f_short)).toFixed(4)}   платит: ${r.f_long<0?"шорты":"лонги"}`);
  const payerOi = r.f_long<0? S:L, recvOi = r.f_long<0? L:S;
  const payRate = Math.abs(r.f_long<0? r.f_short : r.f_long);
  console.log(`          платящая сторона OI=$${payerOi.toFixed(0)} по ставке ${apr(payRate).toFixed(1)}% год  => поток $${(payerOi*payRate*3600*8760).toFixed(0)}/год на всю получающую сторону ($${recvOi.toFixed(0)})`);
}
