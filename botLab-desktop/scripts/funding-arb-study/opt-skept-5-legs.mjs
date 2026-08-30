// Скептик 5. Из чего сделан выигрыш при равном капитале: ноги портфеля и строгий периметр.
import fs from "node:fs";
import { MK, TOKS, applyDilution, grossParts, costEmp, scanTwoLeg, $, SP } from "./opt-size-lib.mjs";
const cap63 = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((c) => [c.t, c]));
const HL = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const roomOf = (t, cfg) => { const c = cap63.get(t), h = HL.tokens[t];
  const g = c ? (cfg === "A" ? c.availShort : c.availLong) : 0;
  const hl = h ? Math.min(h.raw.buy.visibleNtl, h.raw.sell.visibleNtl) : 0;
  return Math.max(10, Math.min(g, hl)); };
const DENSE = []; for (let e = 1; e <= 7.0001; e += 0.05) DENSE.push(10 ** e);
const PERIM = process.argv[2] || "full";
const take = (p) => (PERIM === "gmx" ? p.f + p.b : p.g);
const D = [];
for (const t of TOKS) {
  const m = MK.get(t); const sc = scanTwoLeg(m.rows, { token: t }); if (!sc) continue;
  const cfg = sc.chosen, lim = roomOf(t, cfg);
  const ys = [], parts = [];
  for (const S of DENSE) { applyDilution(m, cfg, S, 0, 8761, "pot"); const p = grossParts(m, cfg, S, 0, 8761);
    parts.push(p); ys.push(take(p) - costEmp(t, cfg, S)); }
  D.push({ t, cfg, lim, ys, parts });
}
function alloc(C) {
  const items = [];
  for (const d of D) { const pts = [{ S: 0, v: 0, i: -1 }];
    DENSE.forEach((S, i) => { if (S <= d.lim && d.ys[i] > 0) pts.push({ S, v: d.ys[i], i }); });
    const hull = [pts[0]];
    for (const p of pts.slice(1)) { while (true) { const last = hull[hull.length-1];
        if (p.S === last.S) { if (p.v <= last.v) break; hull.pop(); continue; }
        const sl = (p.v - last.v) / (p.S - last.S);
        if (hull.length >= 2) { const pr = hull[hull.length-2];
          if (sl >= (last.v - pr.v)/(last.S - pr.S)) { hull.pop(); continue; } }
        if (sl <= 0) break; hull.push(p); break; } }
    for (let k = 1; k < hull.length; k++) items.push({ t: d.t, dS: hull[k].S - hull[k-1].S,
      dv: hull[k].v - hull[k-1].v, r: (hull[k].v - hull[k-1].v)/(hull[k].S - hull[k-1].S), i: hull[k].i }); }
  items.sort((a,b)=>b.r-a.r);
  let used = 0, val = 0; const idx = new Map();
  for (const it of items) { if (used + it.dS > C) continue; used += it.dS; val += it.dv; idx.set(it.t, it.i); }
  return { used, val, idx };
}
console.log(`периметр дохода: ${PERIM}`);
for (const C of [50000, 100000, 200000]) {
  const a = alloc(C); let f=0,b=0,h=0,cst=0;
  for (const [t,i] of a.idx) { const d = D.find(x=>x.t===t); const p = d.parts[i];
    f+=p.f; b+=p.b; h+=p.h; cst += costEmp(t, d.cfg, DENSE[i]); }
  console.log(`  ${$(C)}: нетто ${$(a.val)}, GMXfund ${$(f)}, GMXborrow ${$(b)}, HLfund ${$(h)}, издержки ${$(-cst)}; доля HL в валовом ${(100*h/(f+h)).toFixed(0)}%`);
  if (C === 100000) { const rows = [...a.idx].map(([t,i])=>{ const d=D.find(x=>x.t===t); const p=d.parts[i];
      return { t, S: DENSE[i], v: d.ys[i], f: p.f, b: p.b, h: p.h }; }).sort((x,y)=>y.v-x.v);
    console.log("  топ-8 вкладчиков (нетто | GMXfund | GMXborrow | HLfund):");
    for (const r of rows.slice(0,8)) console.log(`    ${r.t.padEnd(8)} S=${String("$"+Math.round(r.S)).padStart(8)} ${$(r.v).padStart(8)} | ${$(r.f).padStart(9)} | ${$(r.b).padStart(9)} | ${$(r.h).padStart(9)}`);
    let neg = rows.filter(r=>r.f+r.b<=0); console.log(`  позиций, где нога GMX (фандинг+borrow) В МИНУСЕ: ${neg.length} из ${rows.length}, их нетто ${$(neg.reduce((s,r)=>s+r.v,0))} = ${(100*neg.reduce((s,r)=>s+r.v,0)/a.val).toFixed(0)}% портфеля`); }
}
