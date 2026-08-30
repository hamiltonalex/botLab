import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
// Проверка выравнивания slice(-minRows): совпадают ли КАЛЕНДАРНЫЕ окна у токенов по индексу.
import fs from "node:fs"; import path from "node:path";
import { parseSpreadCsv } from "../../src/engine/format.js";
const SP=STUDY_DATA;
const CACHE=STUDY_CACHE;
const MAJORS=["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC","BCH","DOT","ATOM","ARB","OP","NEAR","SUI","TRX","UNI","AAVE","XLM","TAO","FIL"];
const y2=new Map(), y1=new Map();
for(const t of MAJORS){
  const p=`${SP}/y2/${t}.csv`;
  if(fs.existsSync(p)){const r=parseSpreadCsv(fs.readFileSync(p,"utf8")); if(r.length)y2.set(t,r);}
  const f=fs.readdirSync(CACHE).find(x=>x.startsWith(`${t}_`));
  if(f){const r=parseSpreadCsv(fs.readFileSync(path.join(CACHE,f),"utf8")); if(r.length===8761)y1.set(t,r);}
}
// разрывы по каждому токену
console.log("# ПРОПУЩЕННЫЕ ЧАСЫ В Y2");
for(const [t,r] of y2){
  const miss=[];
  for(let i=1;i<r.length;i++){const d=(r[i].tsHour-r[i-1].tsHour)/3600; if(d>1) for(let k=1;k<d;k++) miss.push(new Date((r[i-1].tsHour+k*3600)*1000).toISOString().slice(0,13));}
  if(miss.length) console.log(`${t.padEnd(6)} ${miss.length}: ${miss.slice(0,6).join(" ")}`);
}
console.log("\n# ВЫРАВНИВАНИЕ slice(-minRows): максимальный разбег меток по общему индексу");
for(const minRows of [15000,12000,8760]){
  const uni=MAJORS.filter(t=>y2.has(t)&&y2.get(t).length>=minRows);
  const tr=uni.map(t=>[t,y2.get(t).slice(-minRows)]);
  let maxDrift=0,at=0,who="";
  for(let i=0;i<minRows;i++){
    let mn=Infinity,mx=-Infinity,mnT="",mxT="";
    for(const [t,r] of tr){const h=r[i].tsHour; if(h<mn){mn=h;mnT=t;} if(h>mx){mx=h;mxT=t;}}
    const d=(mx-mn)/3600; if(d>maxDrift){maxDrift=d;at=i;who=`${mnT}..${mxT}`;}
  }
  console.log(`порог ${minRows} (${uni.length} имён): макс разбег ${maxDrift} ч на индексе ${at} (${who})`);
  console.log(`  старты: ${tr.map(([t,r])=>`${t}=${new Date(r[0].tsHour*1000).toISOString().slice(0,13)}`).join(" ")}`);
  console.log(`  концы:  ${tr.map(([t,r])=>`${t}=${new Date(r[r.length-1].tsHour*1000).toISOString().slice(0,13)}`).join(" ")}`);
}
console.log("\n# ПЕРВЫЙ ПЕРИОД: все ли 8761 строки выровнены по календарю");
{
  const uni=[...y1.keys()];
  let maxDrift=0;
  for(let i=0;i<8761;i++){let mn=Infinity,mx=-Infinity;for(const t of uni){const h=y1.get(t)[i].tsHour; if(h<mn)mn=h; if(h>mx)mx=h;} maxDrift=Math.max(maxDrift,(mx-mn)/3600);}
  console.log(`имён ${uni.length}, макс разбег ${maxDrift} ч; span ${new Date(y1.get("BTC")[0].tsHour*1000).toISOString().slice(0,13)} .. ${new Date(y1.get("BTC")[8760].tsHour*1000).toISOString().slice(0,13)}`);
}
