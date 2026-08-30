// Пункт 6. Цена незнания будущего: S* по прошлому окну против S* по факту окна удержания.
// Конфиг ноги в ОБОИХ вариантах выбирает движок по ОБУЧАЮЩЕМУ окну - меняется только размер.
import fs from "node:fs";
import { MK, TOKS, SIZES, applyDilution, grossParts, costEmp, scanTwoLeg, $, SP } from "./opt-size-lib.mjs";
const cap63 = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((c) => [c.t, c]));
const HL = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const H = Number(process.argv[2] || 30) * 24, TRAIN = Number(process.argv[3] || 90) * 24;
const PERIM = process.argv[4] || "full";   // full = вся пара, gmx = только нога GMX в доходе
const take = (p) => (PERIM === "gmx" ? p.f + p.b : p.g);
const pad = (s, n) => String(s).padStart(n);
const roomOf = (t, cfg) => {
  const c = cap63.get(t), h = HL.tokens[t];
  const g = c ? (cfg === "A" ? c.availShort : c.availLong) : 0;
  const hl = h ? Math.min(h.raw.buy.visibleNtl, h.raw.sell.visibleNtl) : 0;
  return Math.max(10, Math.min(g, hl));
};
const WIN = []; for (let i = TRAIN; i + H <= 8761; i += H) WIN.push(i);
const t0 = Date.now();
// на каждое окно и рынок: реализованная кривая нетто и ОЦЕНКА нетто по обучающему окну
const W = [];
for (const st of WIN) {
  const per = new Map();
  for (const t of TOKS) {
    const m = MK.get(t);
    const sc = scanTwoLeg(m.rows.slice(st - TRAIN, st), { token: t });
    if (!sc) continue;
    const cfg = sc.chosen, lim = roomOf(t, cfg);
    const real = [], est = [];
    for (const S of SIZES) {
      const c = costEmp(t, cfg, S);
      applyDilution(m, cfg, S, st, st + H, "pot");
      real.push(take(grossParts(m, cfg, S, st, st + H)) - c);
      applyDilution(m, cfg, S, st - TRAIN, st, "pot");
      est.push(take(grossParts(m, cfg, S, st - TRAIN, st)) * (H / TRAIN) - c);
    }
    per.set(t, { cfg, lim, real, est, netMedian: sc[cfg].netMedian });
  }
  W.push({ st, per }); process.stdout.write(".");
}
console.log(`\nпериметр дохода: ${PERIM}; окон ${WIN.length} по ${H/24}д, обучение ${TRAIN/24}д, счёт ${((Date.now()-t0)/1000).toFixed(0)} с`);
const YRS = (WIN.length * H) / 8760;

// ---- распределение капитала внутри окна ----
function allocLagrange(per, C, useEst) {
  const pick = new Map(); let cap = 0;
  const solve = (lam) => { let s = 0; const sel = new Map();
    for (const [t, d] of per) { let bv = 0, bi = -1;
      SIZES.forEach((S, i) => { if (S > d.lim) return; const v = (useEst ? d.est[i] : d.real[i]) - lam * S; if (v > bv) { bv = v; bi = i; } });
      if (bi >= 0) { sel.set(t, bi); s += SIZES[bi]; } }
    return { s, sel }; };
  let lo = 0, hi = 1; while (solve(hi).s > C) hi *= 2;
  for (let k = 0; k < 44; k++) { const m = (lo + hi) / 2; if (solve(m).s > C) lo = m; else hi = m; }
  const r = solve(hi); for (const [t, i] of r.sel) pick.set(t, i); cap = r.s;
  return { pick, cap };
}
function realized(per, pick) { let v = 0; for (const [t, i] of pick) v += per.get(t).real[i]; return v; }

console.log("\n=== ЦЕНА НЕЗНАНИЯ БУДУЩЕГО ПРИ ЗАДАННОМ КАПИТАЛЕ (доход в год, эмпирические издержки) ===");
console.log("  капитал | единый C/63 на все | единый на отобранных движком | размер по ПРОШЛОМУ окну | размер ЗАДНИМ ЧИСЛОМ | цена незнания");
for (const C of [10000, 25000, 50000, 75000, 100000, 150000, 200000, 300000, 500000, 700000, 1000000]) {
  let uni = 0, ueng = 0, oos = 0, ins = 0, capO = 0, capI = 0, nO = 0;
  for (const w of W) {
    const Su = C / 63;
    for (const [t, d] of w.per) { let bi = 0; for (let i = 0; i < SIZES.length; i++) if (SIZES[i] <= Math.min(Su, d.lim)) bi = i; uni += d.real[bi]; }
    // базa «как сейчас у бота»: вход только там, где правило движка даёт netMedian>0, поровну
    const sel = [...w.per].filter(([, d]) => d.netMedian > 0);
    if (sel.length) { const Se = C / sel.length;
      for (const [, d] of sel) { let bi = 0; for (let i = 0; i < SIZES.length; i++) if (SIZES[i] <= Math.min(Se, d.lim)) bi = i; ueng += d.real[bi]; } }
    const a = allocLagrange(w.per, C, true), b = allocLagrange(w.per, C, false);
    oos += realized(w.per, a.pick); capO += a.cap; nO += a.pick.size;
    ins += realized(w.per, b.pick); capI += b.cap;
  }
  const f = (x) => pad($(x / YRS), 11);
  console.log(`  ${pad($(C),8)} | ${f(uni)} | ${f(ueng)} | ${f(oos)} (занято ${$(capO/W.length)}) | ${f(ins)} | ${f(ins - oos)} (${(100*(1-oos/ins)).toFixed(0)}%)`);
}

console.log("\n=== БЕЗ ОГРАНИЧЕНИЯ КАПИТАЛА: S* на каждый рынок и окно ===");
{
  let ins = 0, oos = 0, ci = 0, co = 0, ni = 0, no = 0, uni = 0, cu = 0;
  const ratios = [];
  for (const w of W) for (const [t, d] of w.per) {
    let bi = -1, bv = 0; SIZES.forEach((S, i) => { if (S > d.lim) return; if (d.real[i] > bv) { bv = d.real[i]; bi = i; } });
    if (bi >= 0) { ins += d.real[bi]; ci += SIZES[bi]; ni++; }
    let ei = -1, ev = 0; SIZES.forEach((S, i) => { if (S > d.lim) return; if (d.est[i] > ev) { ev = d.est[i]; ei = i; } });
    if (ei >= 0) { oos += d.real[ei]; co += SIZES[ei]; no++; if (bi >= 0) ratios.push(SIZES[ei] / SIZES[bi]); }
  }
  console.log(`  задним числом: позиций ${ni}, средний занятый капитал ${$(ci/W.length)}, доход ${$(ins/YRS)}/год`);
  console.log(`  по прошлому окну: позиций ${no}, средний занятый капитал ${$(co/W.length)}, доход ${$(oos/YRS)}/год  -> ${(100*oos/ins).toFixed(0)}% от оптимума`);
  ratios.sort((a,b)=>a-b);
  const q=(f)=>ratios[Math.min(ratios.length-1,Math.floor(f*ratios.length))];
  console.log(`  S*(прошлое)/S*(факт): медиана x${q(.5).toFixed(2)}, p10 x${q(.1).toFixed(2)}, p90 x${q(.9).toFixed(2)}`);
}

// ---- устойчивость самого S* от окна к окну ----
console.log("\n=== УСТОЙЧИВОСТЬ S* ВО ВРЕМЕНИ (по факту окон, вся пара) ===");
{
  const byTok = new Map();
  for (const w of W) for (const [t, d] of w.per) {
    let bi = -1, bv = 0; SIZES.forEach((S, i) => { if (S > d.lim) return; if (d.real[i] > bv) { bv = d.real[i]; bi = i; } });
    if (!byTok.has(t)) byTok.set(t, []);
    byTok.get(t).push(bi >= 0 ? SIZES[bi] : 0);
  }
  const spread = [];
  for (const [t, xs] of byTok) { const p = xs.filter((x) => x > 0); if (p.length < 3) continue;
    const s = [...p].sort((a,b)=>a-b); spread.push({ t, med: s[s.length>>1], lo: s[0], hi: s[s.length-1], n: p.length, k: xs.length }); }
  spread.sort((a,b)=>b.med-a.med);
  const rat = spread.map((s) => s.hi / Math.max(s.lo,1)).sort((a,b)=>a-b);
  console.log(`  разброс S* по окнам (max/min) внутри рынка: медиана x${rat[rat.length>>1].toFixed(0)}, p25 x${rat[Math.floor(.25*rat.length)].toFixed(0)}, p75 x${rat[Math.floor(.75*rat.length)].toFixed(0)}`);
  console.log("  примеры: " + spread.slice(0, 8).map((s) => `${s.t} $${s.lo}..$${s.hi}(мед $${s.med})`).join("; "));
}

// ---- сильнейшая база единым размером В ТОМ ЖЕ РЕЖИМЕ: сам размер подобран задним числом ----
console.log("\n=== СИЛЬНЕЙШАЯ БАЗА ЕДИНЫМ РАЗМЕРОМ (сам S подобран ЗАДНИМ ЧИСЛОМ, тот же режим окон) ===");
{
  let best = { v: -1e18 };
  console.log("     S на рынок |  занятый капитал | доход/год");
  for (let i = 0; i < SIZES.length; i++) {
    const S = SIZES[i]; let v = 0, cap = 0;
    for (const w of W) for (const [, d] of w.per) {
      let bi = 0; for (let k = 0; k < SIZES.length; k++) if (SIZES[k] <= Math.min(S, d.lim)) bi = k;
      v += d.real[bi]; cap += SIZES[bi];
    }
    cap /= W.length;
    if (v > best.v) best = { S, v, cap };
    if (S >= 316 && S <= 100000) console.log(`  ${pad("$"+S,12)} | ${pad($(cap),16)} | ${pad($(v/YRS),9)}`);
  }
  console.log(`  ЛУЧШИЙ ЕДИНЫЙ: $${best.S} на рынок, капитал ${$(best.cap)}, доход ${$(best.v/YRS)}/год, APR ${(100*best.v/YRS/best.cap).toFixed(1)}%`);
  const a = allocLagrange(W[0].per, best.cap, true);
  let oos = 0, ins = 0, capO = 0;
  for (const w of W) { const x = allocLagrange(w.per, best.cap, true), y = allocLagrange(w.per, best.cap, false);
    oos += realized(w.per, x.pick); capO += x.cap; ins += realized(w.per, y.pick); }
  console.log(`  ТОТ ЖЕ КАПИТАЛ, размер по рынкам: по прошлому окну ${$(oos/YRS)}/год (x${(oos/best.v).toFixed(2)}), задним числом ${$(ins/YRS)}/год (x${(ins/best.v).toFixed(2)})`);
}

// ---- из какой ноги доход у ЧЕСТНОГО (по прошлому окну) портфеля и кто в нём ----
console.log("\n=== СОСТАВ И НОГИ ЧЕСТНОГО ПОРТФЕЛЯ (размер по прошлому окну, капитал $100k) ===");
{
  const C = 100000; let f = 0, b = 0, h = 0, net = 0; const byT = new Map(), szT = new Map();
  for (const w of W) {
    const a = allocLagrange(w.per, C, true);
    for (const [t, i] of a.pick) {
      const d = w.per.get(t), S = SIZES[i], m = MK.get(t);
      applyDilution(m, d.cfg, S, w.st, w.st + H, "pot");
      const p = grossParts(m, d.cfg, S, w.st, w.st + H);
      f += p.f; b += p.b; h += p.h; net += d.real[i];
      byT.set(t, (byT.get(t) || 0) + d.real[i]); szT.set(t, Math.max(szT.get(t) || 0, S));
    }
  }
  console.log(`  GMX-фандинг ${$(f/YRS)}, GMX-borrow ${$(b/YRS)}, HL-фандинг ${$(h/YRS)}, издержки круга ${$((f+b+h-net)/YRS)}, нетто ${$(net/YRS)} в год`);
  console.log(`  доля ноги HL в валовом доходе: ${(100*h/(f+h)).toFixed(0)}%`);
  const top = [...byT].sort((x, y) => y[1] - x[1]);
  console.log("  кто заработал: " + top.slice(0, 10).map(([t, v]) => `${t} ${$(v/YRS)} (макс S $${szT.get(t)})`).join("; "));
  console.log("  кто потерял:   " + top.slice(-6).map(([t, v]) => `${t} ${$(v/YRS)}`).join("; "));
}
