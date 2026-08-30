import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
// НЕЗАВИСИМАЯ перекачка кусков периода 2 через движок и сверка с файлами выгрузки `y2/`.
import fs from "node:fs";
import { fetchGmxHistory, fetchHlHistory, mergeHourly } from "../../src/engine/sources.js";
import { parseSpreadCsv } from "../../src/engine/format.js";
const SP=STUDY_DATA;
const SCAN=STUDY_CACHE+"/_scan_results.csv";
const L=fs.readFileSync(SCAN,"utf8").trim().split("\n");
const ix=Object.fromEntries(L[0].split(",").map((h,i)=>[h,i]));
const MAP=new Map(L.slice(1).map(l=>l.split(",")).map(p=>[p[ix.token],{market:p[ix.gmx_market],coin:p[ix.hl_coin],name:p[ix.gmx_name]}]));

const COLS=["f_long","f_short","b_long","b_short","hl_rate","hl_premium"];
const WINDOWS=[
  ["2023-10-01","2023-10-08",Date.UTC(2023,9,1)/1000,Date.UTC(2023,9,8)/1000],
  ["2024-09-01","2024-09-08",Date.UTC(2024,8,1)/1000,Date.UTC(2024,8,8)/1000],
  ["2025-03-10","2025-03-17",Date.UTC(2025,2,10)/1000,Date.UTC(2025,2,17)/1000],
];
for (const tok of (process.argv[2]||"BTC,BNB,ARB").split(",")) {
  const m=MAP.get(tok);
  const mine=parseSpreadCsv(fs.readFileSync(`${SP}/y2/${tok}.csv`,"utf8"));
  const byH=new Map(mine.map(r=>[r.tsHour,r]));
  for (const [a,b,s,e] of WINDOWS) {
    let g,h;
    try { [g,h]=await Promise.all([fetchGmxHistory(m.market,s,e,"arbitrum"),fetchHlHistory(m.coin,s,e)]); }
    catch(err){ console.log(`${tok} ${a}: ОШИБКА ${String(err).slice(0,80)}`); continue; }
    const ref=mergeHourly(g,h).filter(r=>r.tsHour>=s&&r.tsHour<e);
    let cmp=0,miss=0,bad=0,worst=0,wc="",wh=0;
    for (const r of ref){
      const q=byH.get(r.tsHour);
      if(!q){miss++;continue;}
      cmp++;
      for(const c of COLS){
        const d=Math.abs(r[c]-q[c]); const rel=r[c]!==0?d/Math.abs(r[c]):d;
        if(rel>1e-9){bad++; if(rel>worst){worst=rel;wc=c;wh=r.tsHour;} break;}
      }
    }
    // обратная сторона: часы в моём файле, которых нет в свежей выкачке
    const inWin=mine.filter(r=>r.tsHour>=s&&r.tsHour<e);
    const refH=new Set(ref.map(r=>r.tsHour));
    const extra=inWin.filter(r=>!refH.has(r.tsHour)).length;
    // дубли и монотонность в файле
    console.log(`${tok.padEnd(5)} ${a} | эталон(свежий) ${String(ref.length).padStart(4)} | в файле ${String(inWin.length).padStart(4)} | сверено ${String(cmp).padStart(4)} | нет в файле ${miss} | лишних в файле ${extra} | расхождений ${bad}${bad?` худшее ${worst.toExponential(2)} ${wc} @${new Date(wh*1000).toISOString()}`:""}`);
  }
  // целостность файла целиком
  let dup=0,noninc=0,gaps=0,gapH=0;
  for(let i=1;i<mine.length;i++){const d=mine[i].tsHour-mine[i-1].tsHour; if(d===0)dup++; else if(d<0)noninc++; else if(d>3600){gaps++;gapH+=d/3600-1;}}
  console.log(`  ЦЕЛОСТНОСТЬ ${tok}: строк ${mine.length} дублей ${dup} немонотонных ${noninc} разрывов ${gaps} пропущено часов ${gapH} | span ${(mine[mine.length-1].tsHour-mine[0].tsHour)/3600+1} ч`);
  const zero=mine.filter(r=>r.f_long===0&&r.f_short===0&&r.b_long===0&&r.b_short===0).length;
  console.log(`  нулевых GMX-строк: ${zero} (${(100*zero/mine.length).toFixed(1)}%)`);
}
