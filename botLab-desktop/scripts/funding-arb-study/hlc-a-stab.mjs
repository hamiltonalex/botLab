import fs from "node:fs"; import path from "node:path";
import { parseSpreadCsv, median, CACHE, SP } from "./skept-cap-lib.mjs";
const S = JSON.parse(fs.readFileSync(`${SP}/hlc-a-y1-series.json`,"utf8"));
const meta = new Map(JSON.parse(fs.readFileSync(`${SP}/hlc-a-y1.json`,"utf8")).map(r=>[r.token,r]));
const I = 1.25e-5, CAP=10000;
const pc = x=>(x>=0?"+":"")+(100*x).toFixed(2)+"%";
// доля годового керри из часов на базовой ставке i против часов вне её
const raw = new Map();
for (const f of fs.readdirSync(CACHE).filter(f=>f.endsWith(".csv")&&!f.startsWith("_")))
  raw.set(f.replace(/_\d+_\d+\.csv$/,""), parseSpreadCsv(fs.readFileSync(path.join(CACHE,f),"utf8")));
const out=[];
for (const [t, ser] of Object.entries(S)) {
  const rows = raw.get(t); const m = meta.get(t);
  const rr = rows.filter(r=>[r.f_long,r.f_short,r.b_long,r.b_short,r.hl_rate].every(Number.isFinite));
  let base=0, off=0, nb=0;
  for (const r of rr) { const v = r.hl_rate*CAP; if (Math.abs(r.hl_rate-I)<1e-12) { base+=v; nb++; } else off+=v; }
  const tot = base+off;
  // просадка ноги HL (кумулятив по журналу движка)
  let cum=0,peak=0,dd=0; for (const v of ser){cum+=v; if(cum>peak)peak=cum; if(cum-peak<dd)dd=cum-peak;}
  const yrs = ser.length/8760;
  out.push({t, hours: ser.length, apr:m.aprShort, baseShare: base/tot, offShare: off/tot,
    nbShare: nb/rr.length, ddUsd: dd, ddPct: dd/CAP, w30w: m.w30?m.w30.worst:NaN, w90w: m.w90?m.w90.worst:NaN,
    top1:m.top1, top10:m.top10});
}
out.sort((a,b)=>b.apr-a.apr);
console.log("TOKEN     APR   %часов на i  вклад базы  вклад премии   просадка HL-ноги  худш.30д  худш.90д");
for (const r of out) console.log(`${r.t.padEnd(8)} ${pc(r.apr).padStart(9)} ${(100*r.nbShare).toFixed(1).padStart(6)} ${(100*r.baseShare).toFixed(0).padStart(9)}% ${(100*r.offShare).toFixed(0).padStart(9)}% ${("$"+r.ddUsd.toFixed(0)).padStart(12)} (${pc(r.ddPct)}) ${("$"+r.w30w.toFixed(0)).padStart(8)} ${Number.isFinite(r.w90w)?("$"+r.w90w.toFixed(0)).padStart(8):"      --"}`);
const pos = out.filter(r=>r.apr>0);
console.log(`\nсреди 57 плюсовых: медиана доли часов на базовой ставке ${(100*median(pos.map(r=>r.nbShare))).toFixed(1)}%; медиана вклада базы в годовой керри ${(100*median(pos.map(r=>r.baseShare))).toFixed(0)}%`);
console.log(`медиана просадки ноги HL у плюсовых: ${pc(median(pos.map(r=>r.ddPct)))}; у топ-11 (APR>10%): ${pc(median(out.filter(r=>r.apr>0.10).map(r=>r.ddPct)))}`);
console.log(`медиана худшего 30д окна у плюсовых: $${median(pos.map(r=>r.w30w)).toFixed(0)} на $10k`);
