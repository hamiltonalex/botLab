// Скептик 4. Независимая проверка головных чисел «при равном капитале»,
// своим распределителем (жадный по вогнутой оболочке, НЕ множитель Лагранжа),
// на плотной сетке. Плюс: сколько денег приходит из ЭКСТРАПОЛИРОВАННОЙ зоны стакана.
import fs from "node:fs";
import { MK, TOKS, applyDilution, grossParts, costEmp, costFlat, scanTwoLeg, $, SP } from "./opt-size-lib.mjs";
const cap63 = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((c) => [c.t, c]));
const HL = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const roomOf = (t, cfg) => { const c = cap63.get(t), h = HL.tokens[t];
  const g = c ? (cfg === "A" ? c.availShort : c.availLong) : 0;
  const hl = h ? Math.min(h.raw.buy.visibleNtl, h.raw.sell.visibleNtl) : 0;
  return Math.max(10, Math.min(g, hl)); };
const DENSE = []; for (let e = 1; e <= 7.0001; e += 0.05) DENSE.push(10 ** e);
const CAPHL = process.argv[2] === "measured";   // резать размер последним ИЗМЕРЕННЫМ узлом $500k
const D = [];
for (const t of TOKS) {
  const m = MK.get(t); const sc = scanTwoLeg(m.rows, { token: t }); if (!sc) continue;
  const cfg = sc.chosen; let lim = roomOf(t, cfg);
  if (CAPHL) lim = Math.min(lim, 500000);
  const ys = DENSE.map((S) => { applyDilution(m, cfg, S, 0, 8761, "pot"); return grossParts(m, cfg, S, 0, 8761).g - costEmp(t, cfg, S); });
  D.push({ t, cfg, lim, ys });
}
// жадный по вогнутой оболочке (эквивалент точного решения для сепарабельной задачи)
function alloc(C) {
  const items = [];
  for (const d of D) {
    const pts = [{ S: 0, v: 0 }];
    DENSE.forEach((S, i) => { if (S <= d.lim && d.ys[i] > 0) pts.push({ S, v: d.ys[i] }); });
    // верхняя вогнутая оболочка
    const hull = [pts[0]];
    for (const p of pts.slice(1).sort((a, b) => a.S - b.S)) {
      while (hull.length >= 1) {
        const last = hull[hull.length - 1];
        if (p.S === last.S) { if (p.v <= last.v) break; hull.pop(); continue; }
        const sl = (p.v - last.v) / (p.S - last.S);
        if (hull.length >= 2) { const pr = hull[hull.length - 2];
          if (sl >= (last.v - pr.v) / (last.S - pr.S)) { hull.pop(); continue; } }
        if (sl <= 0) { break; }
        hull.push(p); break;
      }
    }
    for (let i = 1; i < hull.length; i++)
      items.push({ t: d.t, dS: hull[i].S - hull[i-1].S, dv: hull[i].v - hull[i-1].v,
                   r: (hull[i].v - hull[i-1].v) / (hull[i].S - hull[i-1].S), S: hull[i].S });
  }
  items.sort((a, b) => b.r - a.r);
  let used = 0, val = 0; const size = new Map();
  for (const it of items) { if (used + it.dS > C) continue; used += it.dS; val += it.dv; size.set(it.t, it.S); }
  return { used, val, size };
}
function uniform(C) {  // единый размер: C/63, обрезанный потолком
  let best = -1e18, bS = 0;
  for (const S of DENSE) { let v = 0, cap = 0;
    for (const d of D) { const s = Math.min(S, d.lim); if (s > C / 63 + 1e-9) continue;
      let bi = 0; for (let i = 0; i < DENSE.length; i++) if (DENSE[i] <= s) bi = i;
      v += d.ys[bi]; cap += DENSE[bi]; }
    if (cap <= C && v > best) { best = v; bS = S; } }
  return { v: best, S: bS };
}
console.log(`${CAPHL ? "РАЗМЕР СРЕЗАН ИЗМЕРЕННЫМ КРАЕМ СТАКАНА $500k" : "как в замере: потолок = свободное место"}`);
console.log("  капитал | единый (задн.числом) | по рынкам (задн.числом) | раз | занято | из зоны ЭКСТРАПОЛЯЦИИ (>$500k)");
for (const C of [10000, 50000, 100000, 200000, 500000, 1000000]) {
  const a = alloc(C), u = uniform(C);
  let ex = 0, exN = 0;
  for (const [t, S] of a.size) if (S > 500000) { const d = D.find((x) => x.t === t); let bi = 0;
    for (let i = 0; i < DENSE.length; i++) if (DENSE[i] <= S) bi = i; ex += d.ys[bi]; exN++; }
  console.log(`${String("$"+C).padStart(9)} | ${$(u.v).padStart(20)} | ${$(a.val).padStart(23)} | ${(a.val/u.v).toFixed(1).padStart(3)} | ${$(a.used).padStart(8)} | ${$(ex).padStart(9)} (${(100*ex/a.val).toFixed(0)}%, ${exN} рынков)`);
}
console.log("\nсостав портфеля при $100k:");
{ const a = alloc(100000); const rows = [...a.size].map(([t, S]) => { const d = D.find((x) => x.t === t);
    let bi = 0; for (let i = 0; i < DENSE.length; i++) if (DENSE[i] <= S) bi = i; return { t, S, v: d.ys[bi], lim: d.lim }; })
    .sort((x, y) => y.v - x.v);
  for (const r of rows.slice(0, 10)) console.log(`  ${r.t.padEnd(9)} S=${String("$"+Math.round(r.S)).padStart(9)} нетто ${$(r.v).padStart(8)} потолок ${$(r.lim)}`);
  console.log(`  всего позиций ${rows.length}`); }
