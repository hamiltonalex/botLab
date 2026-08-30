// Скептик 8. Независимая проверка «вне выборки»: строгое разделение окон,
// свой распределитель (вогнутая оболочка), контроль на заглядывание.
import fs from "node:fs";
import { MK, TOKS, SIZES, applyDilution, grossParts, costEmp, scanTwoLeg, $, SP } from "./opt-size-lib.mjs";
const cap63 = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((c) => [c.t, c]));
const HL = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const roomOf = (t, cfg) => { const c = cap63.get(t), h = HL.tokens[t];
  const g = c ? (cfg === "A" ? c.availShort : c.availLong) : 0;
  const hl = h ? Math.min(h.raw.buy.visibleNtl, h.raw.sell.visibleNtl) : 0;
  return Math.max(10, Math.min(g, hl)); };
const H = Number(process.argv[2] || 30) * 24, TRAIN = Number(process.argv[3] || 90) * 24;
const PERIM = process.argv[4] || "full", MODE = process.argv[5] || "pot";
const take = (p) => (PERIM === "gmx" ? p.f + p.b : p.g);
const WIN = []; for (let i = TRAIN; i + H <= 8761; i += H) WIN.push(i);
const W = [];
for (const st of WIN) {
  const per = new Map();
  for (const t of TOKS) {
    const m = MK.get(t);
    const tr = m.rows.slice(st - TRAIN, st);
    const sc = scanTwoLeg(tr, { token: t }); if (!sc) continue;
    const cfg = sc.chosen, lim = roomOf(t, cfg);
    const real = [], est = [];
    for (const S of SIZES) {
      const c = costEmp(t, cfg, S);
      applyDilution(m, cfg, S, st, st + H, MODE);     real.push(take(grossParts(m, cfg, S, st, st + H)) - c);
      applyDilution(m, cfg, S, st - TRAIN, st, MODE); est.push(take(grossParts(m, cfg, S, st - TRAIN, st)) * (H / TRAIN) - c);
    }
    per.set(t, { cfg, lim, real, est });
  }
  W.push({ st, per });
}
const YRS = (WIN.length * H) / 8760;
// КОНТРОЛЬ НА ЗАГЛЯДЫВАНИЕ: est не должна коррелировать с real сильнее, чем это возможно
{ let n = 0, agree = 0;
  for (const w of W) for (const [, d] of w.per) { n++;
    let ei = 0, ri = 0; SIZES.forEach((S, i) => { if (S > d.lim) return; if (d.est[i] > d.est[ei]) ei = i; if (d.real[i] > d.real[ri]) ri = i; });
    if (ei === ri) agree++; }
  console.log(`контроль: точное совпадение узла S* оценки и факта ${agree}/${n} (${(100*agree/n).toFixed(1)}%) - при подглядывании было бы 100%`);
}
function alloc(per, C, key) { const items = [];
  for (const [t, d] of per) { const pts = [{S:0,v:0,i:-1}];
    SIZES.forEach((S,i)=>{ if (S<=d.lim && d[key][i]>0) pts.push({S,v:d[key][i],i}); });
    const hull=[pts[0]];
    for (const p of pts.slice(1)) { while(true){ const l=hull[hull.length-1];
      if (p.S===l.S){ if(p.v<=l.v) break; hull.pop(); continue; }
      const sl=(p.v-l.v)/(p.S-l.S);
      if (hull.length>=2){ const pr=hull[hull.length-2]; if (sl>=(l.v-pr.v)/(l.S-pr.S)){ hull.pop(); continue; } }
      if (sl<=0) break; hull.push(p); break; } }
    for (let k=1;k<hull.length;k++) items.push({t,dS:hull[k].S-hull[k-1].S,dv:hull[k].v-hull[k-1].v,r:(hull[k].v-hull[k-1].v)/(hull[k].S-hull[k-1].S),i:hull[k].i}); }
  items.sort((a,b)=>b.r-a.r); let used=0; const idx=new Map();
  for (const it of items){ if (used+it.dS>C) continue; used+=it.dS; idx.set(it.t,it.i); }
  let realized = 0; for (const [t,i] of idx) realized += per.get(t).real[i];
  return { used, idx, realized }; }
console.log(`\nпериметр ${PERIM}, разбавление ${MODE}, окна ${H/24}д, обучение ${TRAIN/24}д, окон ${WIN.length}`);
console.log("  капитал |  единый C/63 | единый ЛУЧШИЙ (задн.числом) | по прошлому окну | задним числом | цена незнания");
for (const C of [10000, 50000, 100000, 200000, 300000, 500000, 1000000]) {
  let uni = 0, oos = 0, ins = 0, capO = 0;
  for (const w of W) { const Su = C/63;
    for (const [, d] of w.per) { let bi = 0; for (let i=0;i<SIZES.length;i++) if (SIZES[i] <= Math.min(Su, d.lim)) bi = i; uni += d.real[bi]; }
    const a = alloc(w.per, C, "est"), b = alloc(w.per, C, "real");
    oos += a.realized; capO += a.used; ins += b.realized; }
  // лучший единый размер задним числом при бюджете C
  let bu = -1e18;
  for (const S of SIZES) { if (S > C/63) continue; let v = 0;
    for (const w of W) for (const [, d] of w.per) { let bi = 0; for (let i=0;i<SIZES.length;i++) if (SIZES[i] <= Math.min(S, d.lim)) bi = i; v += d.real[bi]; }
    if (v > bu) bu = v; }
  console.log(`${String("$"+C).padStart(9)} | ${$(uni/YRS).padStart(12)} | ${$(bu/YRS).padStart(27)} | ${($(oos/YRS)+" (занято "+$(capO/W.length)+")").padStart(16)} | ${$(ins/YRS).padStart(13)} | ${(100*(1-oos/ins)).toFixed(0)}%`);
}
