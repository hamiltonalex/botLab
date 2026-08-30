import fs from "node:fs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30 = 1e30, CEIL = 1e-7, YR = 3600*8760;
const T = ["FET","S","MOODENG","BERA","FLOKI","EIGEN","WLD","STX","BONK","MEME","BOME","ORDI","TIA","LDO","WIF","AIXBT","INJ","POL"];
function med(a){const s=[...a].sort((x,y)=>x-y);return s.length?s[Math.floor(s.length/2)]:NaN;}
console.log("Часы с аномальной ставкой: сколько там ОТКРЫТОГО ИНТЕРЕСА на стороне, которая ПОЛУЧАЕТ");
console.log("токен  аном.часов  медиана OI получателя $   медиана OI в норм.часы $  $/час при аном. ставке");
const rows=[];
for (const t of T) {
  const oi = new Map(JSON.parse(fs.readFileSync(`truth-b-raw/oi_${t}.json`,"utf8"))
    .map(r=>[Math.floor(r.snapshotTimestamp/3600)*3600,{L:Number(r.longOpenInterestUsd)/E30,S:Number(r.shortOpenInterestUsd)/E30}]));
  const aRecv=[], nRecv=[], aPay=[];
  for (const r of cacheRows(t)) {
    const h=Math.floor(Date.parse(r.ts.replace(" ","T"))/1000/3600)*3600;
    const o=oi.get(h); if(!o) continue;
    const fl=+r.f_long, fs2=+r.f_short;
    const isAnom = Math.max(Math.abs(fl),Math.abs(fs2))>CEIL;
    // получатель = сторона с положительным фактором
    const recvOi = fl>0 ? o.L : o.S, payOi = fl>0 ? o.S : o.L;
    const rate = Math.max(Math.abs(fl),Math.abs(fs2));
    if(isAnom){aRecv.push(recvOi); aPay.push(Math.abs(fl>0?fs2:fl)*payOi*3600);} else nRecv.push(recvOi);
  }
  const r={t,nAnom:aRecv.length,medA:med(aRecv),medN:med(nRecv),medPay:med(aPay)};
  rows.push(r);
  console.log(t.padEnd(7),String(r.nAnom).padStart(9),("$"+r.medA.toFixed(2)).padStart(22),("$"+Math.round(r.medN).toLocaleString("ru-RU")).padStart(25),("$"+r.medPay.toFixed(4)).padStart(20));
}
fs.writeFileSync("truth-b-capacity.json",JSON.stringify(rows,null,1));
