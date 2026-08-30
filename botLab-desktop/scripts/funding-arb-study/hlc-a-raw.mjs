// ЗАДАЧА А: сырой керри ноги HL. Начисление считает движок paper.js, аннуализация annualizeRow.
import fs from "node:fs"; import path from "node:path";
import { parseSpreadCsv, annualizeRow, median, openPosition, accrueFromRows, closePosition, positionSummary, CACHE, SP } from "./skept-cap-lib.mjs";

const CAP = 10000, HOUR_MS = 3600000;

// Прогон ОДНОЙ позиции через движок; возвращает журнал начислений.
function runLeg(rows, cfg) {
  const p = openPosition({ strategy: "two", instrumentKey: "X", config: cfg, capital: CAP, leverage: 1,
    nowMs: rows[0].tsHour * 1000, roundTripCost: 0 });
  accrueFromRows(p, rows, rows[rows.length - 1].tsHour * 1000 + HOUR_MS);
  closePosition(p, rows[rows.length - 1].tsHour * 1000 + HOUR_MS);
  return p;
}

function q(xs, p) { const f = xs.filter(Number.isFinite).slice().sort((a,b)=>a-b); if (!f.length) return NaN;
  const i = (f.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? f[lo] : f[lo] + (f[hi] - f[lo]) * (i - lo); }

function analyze(token, rows) {
  const B = runLeg(rows, "B");            // ШОРТ HL
  const A = runLeg(rows, "A");            // ЛОНГ HL
  const hlB = B.accruals.map(a => a.dPnlHl);   // вклад ноги HL, посчитанный движком
  const hlA = A.accruals.map(a => a.dPnlHl);
  const gmxB = B.accruals.map(a => a.dPnlGmx);
  const sum = xs => xs.reduce((s,x)=>s+x,0);
  const usdShort = sum(hlB), usdLong = sum(hlA);
  const hours = B.accruals.length;
  const yrs = hours / 8760;
  // аннуализация из движка (annualizeRow) для сверки величин ставок
  const ann = rows.map(annualizeRow);
  const hlAnn = ann.map(r => r.hl_short_recv);                      // hl_rate*8760
  const gmxShortAnn = ann.map(r => r.gmx_short_recv);               // f_short*3600*8760
  const gmxLongAnn = ann.map(r => r.gmx_long_recv);
  const posHours = hlB.filter(x=>x>0).length;
  let flips = 0; for (let i=1;i<hlB.length;i++) if ((hlB[i]>0?1:0) !== (hlB[i-1]>0?1:0)) flips++;
  // концентрация: доля годового керри из лучших часов
  const srt = hlB.slice().sort((a,b)=>b-a);
  const topShare = f => sum(srt.slice(0, Math.max(1, Math.round(hours*f)))) / usdShort;
  const posSum = sum(hlB.filter(x=>x>0)), negSum = sum(hlB.filter(x=>x<0));
  // скользящие окна (шаг сутки)
  const win = (W) => { if (hours < W) return null; const pre = [0]; for (const v of hlB) pre.push(pre[pre.length-1]+v);
    let n=0,p=0,worst=Infinity,best=-Infinity;
    for (let i=0;i+W<=hours;i+=24){ const v = pre[i+W]-pre[i]; n++; if (v>0)p++; if(v<worst)worst=v; if(v>best)best=v; }
    return { n, fracPos: p/n, worst, best }; };
  return { token, hours, yrs, usdShort, usdLong,
    aprShort: usdShort/CAP/yrs, aprLong: usdLong/CAP/yrs,
    fracPosHours: posHours/hours, flips,
    w30: win(720), w90: win(2160),
    top1: topShare(0.01), top5: topShare(0.05), top10: topShare(0.10),
    posSum, negSum,
    meanAbsHl: sum(hlAnn.map(Math.abs))/hours, medAbsHl: median(hlAnn.map(Math.abs)),
    meanAbsGmxS: sum(gmxShortAnn.map(Math.abs))/hours, medAbsGmxS: median(gmxShortAnn.map(Math.abs)),
    meanGmxS: sum(gmxShortAnn)/hours, meanGmxL: sum(gmxLongAnn)/hours, meanHl: sum(hlAnn)/hours,
    gmxLegUsd: sum(gmxB),
    hlSeries: hlB };
}

const which = process.argv[2] || "y1";
let set = new Map();
if (which === "y1") {
  for (const f of fs.readdirSync(CACHE).filter(f=>f.endsWith(".csv") && !f.startsWith("_")))
    set.set(f.replace(/_\d+_\d+\.csv$/,""), parseSpreadCsv(fs.readFileSync(path.join(CACHE,f),"utf8")));
} else {
  for (const f of fs.readdirSync(`${SP}/y2`).filter(f=>f.endsWith(".csv")))
    set.set(f.replace(/\.csv$/,""), parseSpreadCsv(fs.readFileSync(`${SP}/y2/${f}`,"utf8")));
}
const out = [];
for (const [t, rows] of set) {
  if (!rows.length) continue;
  const bad = rows.filter(r => ![r.f_long,r.f_short,r.b_long,r.b_short,r.hl_rate].every(Number.isFinite)).length;
  const r = analyze(t, rows); r.badRows = bad; r.rawRows = rows.length; out.push(r);
}
out.sort((a,b)=>b.aprShort-a.aprShort);
fs.writeFileSync(`${SP}/hlc-a-${which}.json`, JSON.stringify(out.map(({hlSeries,...r})=>r), null, 1));
// сериализуем часовые ряды отдельно (для концентрации/окон в отчётных скриптах)
fs.writeFileSync(`${SP}/hlc-a-${which}-series.json`, JSON.stringify(Object.fromEntries(out.map(r=>[r.token, r.hlSeries]))));

const pc = x => (x>=0?"+":"")+(100*x).toFixed(2)+"%";
console.log(`период=${which} монет=${out.length}`);
console.log("TOKEN   ч    badR  $short(10k)  APRshort  APRlong  доля+ч  смен  top1%  top5% top10%  w30+  w90+");
for (const r of out) console.log(
  `${r.token.padEnd(7)} ${String(r.hours).padStart(5)} ${String(r.badRows).padStart(4)} ${r.usdShort.toFixed(0).padStart(9)}  ${pc(r.aprShort).padStart(9)} ${pc(r.aprLong).padStart(9)} ${(100*r.fracPosHours).toFixed(1).padStart(6)} ${String(r.flips).padStart(5)} ${(100*r.top1).toFixed(1).padStart(6)} ${(100*r.top5).toFixed(1).padStart(6)} ${(100*r.top10).toFixed(1).padStart(6)} ${r.w30?(100*r.w30.fracPos).toFixed(0).padStart(4):"  --"} ${r.w90?(100*r.w90.fracPos).toFixed(0).padStart(4):"  --"}`);

const aprs = out.map(r=>r.aprShort);
console.log("\n--- распределение APR шорта HL (без издержек, $10k, плечо 1) ---");
console.log(`медиана ${pc(median(aprs))}  Q1 ${pc(q(aprs,0.25))}  Q3 ${pc(q(aprs,0.75))}  min ${pc(Math.min(...aprs))} (${out[out.length-1].token})  max ${pc(Math.max(...aprs))} (${out[0].token})`);
console.log(`монет с APR>0: ${aprs.filter(x=>x>0).length}/${aprs.length}; >10%: ${aprs.filter(x=>x>0.10).length}; >20%: ${aprs.filter(x=>x>0.20).length}; >5%: ${aprs.filter(x=>x>0.05).length}`);
const dp = out.map(r=>r.fracPosHours), f1=out.map(r=>r.top1), f10=out.map(r=>r.top10);
console.log(`медиана доли + часов: ${(100*median(dp)).toFixed(1)}%  ; медиана top1%: ${(100*median(f1)).toFixed(1)}%  top10%: ${(100*median(f10)).toFixed(1)}%`);
const w30 = out.filter(r=>r.w30).map(r=>r.w30.fracPos), w90 = out.filter(r=>r.w90).map(r=>r.w90.fracPos);
console.log(`медиана доли плюсовых 30д окон ${(100*median(w30)).toFixed(1)}% ; 90д ${(100*median(w90)).toFixed(1)}%`);
const rat = out.map(r=>r.meanAbsHl/r.meanAbsGmxS).filter(Number.isFinite);
console.log(`\n--- HL против GMX (|аннуализированная ставка|, среднее по часам) ---`);
console.log(`медиана отношения |HL|/|GMX f_short|: ${median(rat).toFixed(3)}  ; монет где HL крупнее: ${rat.filter(x=>x>1).length}/${rat.length}`);
console.log(`медиана средн.|HL| ${pc(median(out.map(r=>r.meanAbsHl)))} против средн.|GMX| ${pc(median(out.map(r=>r.meanAbsGmxS)))}`);
