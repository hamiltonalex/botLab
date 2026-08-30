import fs from "node:fs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30=1e30, YR=3600*8760, MIN=3.1710e-10;
const TOKS=JSON.parse(fs.readFileSync("cap63.json","utf8")).map(x=>x.t);
const M={};
for(const t of TOKS){ const rows=cacheRows(t); if(!rows) continue;
  let oi; try{ oi=JSON.parse(fs.readFileSync(`truth-a-oi2/${t}.json`,"utf8")).oi; }catch(e){ continue; }
  const om=new Map(); for(const o of oi) om.set(o.snapshotTimestamp,o);
  const out=[];
  for(const r of rows){ const h=Math.floor(Date.parse(r.ts.replace(" ","T"))/1000/3600)*3600;
    const o=om.get(h); if(!o) continue;
    const bl=Number(o.longFundingBalanceOiUsd)/E30, bs=Number(o.shortFundingBalanceOiUsd)/E30;
    if(!(bl>0&&bs>0)) continue;
    const fl=+r.f_long, fs=+r.f_short; if(!(fl!==0&&fs!==0)) continue;
    const longPays=fl<0;
    out.push({pr:Math.abs(longPays?fl:fs), pb:longPays?bl:bs, rr:Math.abs(longPays?fs:fl), rb:longPays?bs:bl}); }
  M[t]=out; }
console.log("# ВХОД НА СТОРОНУ-ПОЛУЧАТЕЛЯ КАЖДОГО ИЗ 63 РЫНКОВ, каждый час года. Плательщик определён ПО ЗНАКУ.");
console.log("| N на рынок | капитал | как книжит движок | доля потока | часов, где вход делает нас большей стороной | +смена знака, минимум 1% | +смена знака, по ставке плательщика |");
console.log("|---|---|---|---|---|---|---|");
for(const N of [1000,5000,10000,50000,100000]){
  let naive=0,dil=0,lo=0,hi=0,H=0,cross=0,already=0;
  for(const t of TOKS){ for(const r of (M[t]||[])){ H++;
    const flow=r.pr*r.pb*3600;
    naive += r.rr*3600*N;
    const sh=flow*N/(r.rb+N); dil+=sh;
    if(r.rb>r.pb){ already++; lo+=sh; hi+=sh; }
    else if(r.rb+N>r.pb){ cross++; lo+=-MIN*3600*N; hi+=-r.pr*3600*N; }
    else { lo+=sh; hi+=sh; } } }
  const cap=N*63, f=x=>`$${Math.round(x).toLocaleString("ru-RU")} (${(100*x/cap).toFixed(1)}%)`;
  console.log(`| $${N.toLocaleString("ru-RU")} | $${cap.toLocaleString("ru-RU")} | ${f(naive)} | ${f(dil)} | ${(100*cross/H).toFixed(1)}% | ${f(lo)} | ${f(hi)} |`);
  if(N===10000) console.log(`|  |  |  |  | (плюс ${(100*already/H).toFixed(1)}% часов, где наша сторона БОЛЬШЕ и без нас: инерция GMX) |  |  |`);
}
