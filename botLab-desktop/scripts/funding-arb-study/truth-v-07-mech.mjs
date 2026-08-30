import {q,MAP,all} from "./truth-v-lib.mjs";
// Механика: меняется ли ставка ТОЛЬКО когда рынок трогают?
for(const t of ["BOME","MELANIA","PEPE"]){
  const a=MAP.get(t).market;
  const rows=all.get(t);
  const t0=rows[0].tsHour, t1=rows[0].tsHour+180*86400;   // полгода
  // все смены значения в кэше
  const ch=[]; for(let i=1;i<rows.length;i++) if(rows[i].tsHour<t1 && (rows[i].f_long!==rows[i-1].f_long||rows[i].f_short!==rows[i-1].f_short)) ch.push(rows[i].tsHour);
  // все сделки
  const tr=[]; let cur=t0;
  while(cur<t1){
    const d=await q(`{ tradeActions(limit:1000, orderBy: timestamp_ASC, where:{marketAddress_eq:"${a}", eventName_eq:"OrderExecuted", timestamp_gte:${cur}, timestamp_lt:${t1}}){ timestamp } }`);
    const arr=d.tradeActions; if(!arr.length) break;
    tr.push(...arr.map(x=>x.timestamp)); cur=arr[arr.length-1].timestamp+1; if(arr.length<1000) break;
  }
  const trS=tr.slice().sort((a,b)=>a-b);
  // для каждой смены ставки: была ли сделка в предыдущем часе
  const near=ch.filter(c=>{ let lo=0,hi=trS.length-1,ok=false;
    for(const x of trS){ if(x>=c-3600 && x<c+1){ ok=true; break; } if(x>c) break; } return ok; });
  // для каждого часа БЕЗ сделки: стояла ли ставка
  const hset=new Set(trS.map(x=>Math.floor(x/3600)*3600));
  let noTradeFroze=0,noTradeMoved=0,tradeFroze=0,tradeMoved=0;
  for(let i=1;i<rows.length;i++){ if(rows[i].tsHour>=t1) break;
    const moved = rows[i].f_long!==rows[i-1].f_long||rows[i].f_short!==rows[i-1].f_short;
    const traded = hset.has(rows[i-1].tsHour)||hset.has(rows[i].tsHour);
    if(traded){ moved?tradeMoved++:tradeFroze++; } else { moved?noTradeMoved++:noTradeFroze++; }
  }
  console.log(`\n${t}  первые 180 суток кэша: сделок ${trS.length}, смен ставки ${ch.length}`);
  console.log(`  смен ставки, у которых сделка была в том же/предыдущем часе: ${near.length}/${ch.length} = ${(100*near.length/ch.length).toFixed(1)}%`);
  console.log(`  часы СО сделкой: ставка сдвинулась ${tradeMoved}, стояла ${tradeFroze}`);
  console.log(`  часы БЕЗ сделки: ставка сдвинулась ${noTradeMoved}, стояла ${noTradeFroze}`);
}
