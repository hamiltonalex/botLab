// Пункт 3 при РАВНОМ капитале (иначе сравнение нечестное) + вклад ног в оптимум при S*.
import fs from "node:fs";
import { MK, TOKS, SIZES, applyDilution, grossParts, costEmp, $, SP } from "./opt-size-lib.mjs";
const { out } = JSON.parse(fs.readFileSync(`${SP}/opt-size-year.json`, "utf8"));
const cap63 = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((c) => [c.t, c]));
const HL = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const pad = (s, n) => String(s).padStart(n);
const roomOf = (t) => { const c = cap63.get(t), h = HL.tokens[t];
  const g = c ? (out[t].cfg === "A" ? c.availShort : c.availLong) : 0;
  return Math.max(10, Math.min(g, h ? Math.min(h.raw.buy.visibleNtl, h.raw.sell.visibleNtl) : 0)); };
const netAt = (t, i) => out[t].pot[i] - costEmp(t, out[t].cfg, SIZES[i]);
const netLive = (t, S) => { const m = MK.get(t), cfg = out[t].cfg;
  applyDilution(m, cfg, S, 0, 8761, "pot"); const d = grossParts(m, cfg, S, 0, 8761);
  return { net: d.g - costEmp(t, cfg, S), f: d.f, b: d.b, h: d.h }; };
const alloc = (lam) => { const sel = new Map(); let s = 0;
  for (const t of TOKS) { const lim = roomOf(t); let bv = 0, bi = -1;
    SIZES.forEach((S, i) => { if (S > lim) return; const v = netAt(t, i) - lam * S; if (v > bv) { bv = v; bi = i; } });
    if (bi >= 0) { sel.set(t, bi); s += SIZES[bi]; } }
  return { sel, s }; };
const forC = (C) => { let lo = 0, hi = 1; while (alloc(hi).s > C) hi *= 2;
  for (let k = 0; k < 44; k++) { const m = (lo + hi) / 2; if (alloc(m).s > C) lo = m; else hi = m; } return alloc(hi); };

console.log("=== РАЗЛОЖЕНИЕ ВЫИГРЫША ПРИ РАВНОМ КАПИТАЛЕ (держим год, эмпирические издержки) ===");
for (const C of [50000, 100000, 200000, 500000]) {
  const Su = C / 63;
  const base = new Map(TOKS.map((t) => [t, netLive(t, Math.min(Su, roomOf(t))).net]));
  const a = forC(C);
  const kept = [...a.sel.keys()], dropped = TOKS.filter((t) => !a.sel.has(t));
  const B = TOKS.reduce((s, t) => s + base.get(t), 0);
  const O = kept.reduce((s, t) => s + netAt(t, a.sel.get(t)), 0);
  const gF = dropped.reduce((s, t) => s - base.get(t), 0);
  const gS = kept.reduce((s, t) => s + netAt(t, a.sel.get(t)) - base.get(t), 0);
  const up = kept.filter((t) => SIZES[a.sel.get(t)] > Su), dn = kept.filter((t) => SIZES[a.sel.get(t)] < Su);
  console.log(`\n  капитал ${$(C)}: единый по $${Su.toFixed(0)} на 63 рынка -> ${$(B)}   |   свой размер на ${kept.length} рынках -> ${$(O)} (занято ${$(a.s)})`);
  console.log(`    вклад ОТСЕВА (${dropped.length} рынков не финансируем): ${$(gF)}  (${(100*gF/(O-B)).toFixed(0)}% выигрыша)`);
  console.log(`    вклад РАЗМЕРА на профинансированных:                 ${$(gS)}  (${(100*gS/(O-B)).toFixed(0)}%)`);
  console.log(`      из них: подняли размер на ${up.length} рынках -> ${$(up.reduce((s,t)=>s+netAt(t,a.sel.get(t))-base.get(t),0))}; опустили на ${dn.length} -> ${$(dn.reduce((s,t)=>s+netAt(t,a.sel.get(t))-base.get(t),0))}`);
  const top = kept.map((t) => ({ t, S: SIZES[a.sel.get(t)], v: netAt(t, a.sel.get(t)) })).sort((x, y) => y.v - x.v);
  console.log(`    топ-6: ` + top.slice(0, 6).map((x) => `${x.t} $${x.S}->${$(x.v)}`).join("; "));
}

console.log("\n=== ИЗ КАКОЙ НОГИ ДОХОД ПРИ ОПТИМАЛЬНЫХ РАЗМЕРАХ (капитал $200k) ===");
{
  const a = forC(200000); let f = 0, b = 0, h = 0, n = 0;
  for (const [t, i] of a.sel) { const d = netLive(t, SIZES[i]); f += d.f; b += d.b; h += d.h; n += d.net; }
  console.log(`  GMX-фандинг ${$(f)}, GMX-borrow ${$(b)}, HL-фандинг ${$(h)}, издержки круга ${$(f+b+h-n)}, нетто ${$(n)}`);
  console.log(`  доля ноги HL в валовом доходе: ${(100*h/(f+h)).toFixed(0)}%`);
}
console.log("\n=== ЧУВСТВИТЕЛЬНОСТЬ: тот же счёт в строгом режиме (наш вход делает нас большей стороной -> доход 0) ===");
{
  const netFlip = (t, i) => out[t].flip[i] - costEmp(t, out[t].cfg, SIZES[i]);
  const allocF = (lam) => { const sel = new Map(); let s = 0;
    for (const t of TOKS) { const lim = roomOf(t); let bv = 0, bi = -1;
      SIZES.forEach((S, i) => { if (S > lim) return; const v = netFlip(t, i) - lam * S; if (v > bv) { bv = v; bi = i; } });
      if (bi >= 0) { sel.set(t, bi); s += SIZES[bi]; } } return { sel, s }; };
  for (const C of [100000, 200000]) {
    let lo = 0, hi = 1; while (allocF(hi).s > C) hi *= 2;
    for (let k = 0; k < 44; k++) { const m = (lo + hi) / 2; if (allocF(m).s > C) lo = m; else hi = m; }
    const a = allocF(hi); const v = [...a.sel].reduce((s, [t, i]) => s + netFlip(t, i), 0);
    const Su = C / 63; const B = TOKS.reduce((s, t) => { let bi = 0; for (let i = 0; i < SIZES.length; i++) if (SIZES[i] <= Math.min(Su, roomOf(t))) bi = i; return s + netFlip(t, bi); }, 0);
    console.log(`  капитал ${$(C)}: единый ${$(B)} -> свой размер ${$(v)} (рынков ${a.sel.size}, занято ${$(a.s)})`);
  }
}
