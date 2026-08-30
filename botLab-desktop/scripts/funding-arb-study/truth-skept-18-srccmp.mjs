import fs from "node:fs";
import { TOKS } from "./truth-skept-9-core.mjs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30=1e30;
const bits=(x)=>{const b=new ArrayBuffer(8);new DataView(b).setFloat64(0,x);return new DataView(b).getBigUint64(0);};
let n=0,eq=0,ulp1=0,near=0,mid=0,big=0,srcZero=0,cacheZero=0,missSrc=0;
let anomN=0,anomConf=0,anomSrcAnom=0,anomZero=0;
const perTok={};
for(const t of TOKS){
  let src; try{src=JSON.parse(fs.readFileSync(`truth-a-src/${t}.json`,"utf8"));}catch(e){continue;}
  const sm=new Map(); for(const s of src.funding) sm.set(s.snapshotTimestamp,s);
  const rows=cacheRows(t); if(!rows) continue;
  let tz=0,tn=0;
  for(const r of rows){
    const h=Math.floor(Date.parse(r.ts.replace(" ","T"))/1000/3600)*3600;
    const s=sm.get(h); if(!s){missSrc++;continue;}
    for(const [ck,sk] of [["f_long","fundingFactorPerSecondLong"],["f_short","fundingFactorPerSecondShort"]]){
      const c=+r[ck], v=Number(s[sk])/E30;
      n++; tn++;
      if(c===v){eq++;continue;}
      if(v===0&&c!==0){srcZero++;tz++;continue;}
      if(c===0&&v!==0){cacheZero++;continue;}
      const d=Math.abs(c-v)/Math.max(Math.abs(c),Math.abs(v));
      const ub=Number(bits(Math.abs(c))-bits(Math.abs(v)));
      if(Math.abs(ub)<=1) ulp1++;
      else if(d<1e-9) near++;
      else if(d<1e-3) mid++;
      else big++;
    }
    // аномальные часы кэша
    const cl=Math.abs(+r.f_long), cs=Math.abs(+r.f_short);
    if(Math.max(cl,cs)>1e-7){
      anomN++;
      const sl=Math.abs(Number(s.fundingFactorPerSecondLong)/E30), ss=Math.abs(Number(s.fundingFactorPerSecondShort)/E30);
      if(sl===0&&ss===0){anomZero++;}
      else{
        const mc=Math.max(cl,cs), ms=Math.max(sl,ss);
        if(Math.abs(mc-ms)/mc<1e-9) anomConf++;
        if(ms>1e-7) anomSrcAnom++;
      }
    }
  }
  perTok[t]={zeroFrac:tz/tn};
}
console.log("СВЕРКА КЭША С ПЕРЕЗАПРОШЕННЫМ ИСТОЧНИКОМ (значений = 2 стороны x час)");
console.log("  всего значений", n.toLocaleString("ru-RU"), " нет снимка в источнике:", missSrc);
const P=(x)=>(100*x/n).toFixed(2)+"%";
console.log("  побитово равно            ", eq.toLocaleString("ru-RU").padStart(9), P(eq));
console.log("  разница <=1 ulp           ", ulp1.toLocaleString("ru-RU").padStart(9), P(ulp1));
console.log("  относительная <1e-9 (проч)", near.toLocaleString("ru-RU").padStart(9), P(near));
console.log("  1e-9..1e-3                ", mid.toLocaleString("ru-RU").padStart(9), P(mid));
console.log("  >=1e-3                    ", big.toLocaleString("ru-RU").padStart(9), P(big));
console.log("  источник СЕГОДНЯ = 0, кэш живой", srcZero.toLocaleString("ru-RU").padStart(6), P(srcZero));
console.log("  кэш = 0, источник живой   ", cacheZero.toLocaleString("ru-RU").padStart(9), P(cacheZero));
console.log("  ИТОГО совпадение в пределах 1e-9:", (eq+ulp1+near).toLocaleString("ru-RU"), P(eq+ulp1+near));
console.log("\nАНОМАЛЬНЫЕ ЧАСЫ КЭША:", anomN.toLocaleString("ru-RU"));
console.log("  подтверждены источником (1e-9):", anomConf.toLocaleString("ru-RU"), (100*anomConf/anomN).toFixed(2)+"%");
console.log("  источник тоже выше 1e-7:       ", anomSrcAnom.toLocaleString("ru-RU"), (100*anomSrcAnom/anomN).toFixed(2)+"%");
console.log("  источник сегодня отдаёт 0:     ", anomZero.toLocaleString("ru-RU"), (100*anomZero/anomN).toFixed(2)+"%");
