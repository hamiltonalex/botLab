// Скептик 9. Независимая проверка базы (единый размер, год, DEFAULT_COSTS движка) и полноты данных.
import { MK, TOKS, applyDilution, resetRows, grossOf, costFlat, scanTwoLeg, $ } from "./opt-size-lib.mjs";
const cfgs = new Map();
for (const t of TOKS) { const sc = scanTwoLeg(MK.get(t).rows, { token: t }); if (sc) cfgs.set(t, sc.chosen); }
console.log("рынков с конфигом:", cfgs.size);
console.log("  S на рынок |    капитал | нетто в год");
let best = { v: -1e18 };
const grid = []; for (let e = 2; e <= 5.0001; e += 0.05) grid.push(Math.round(10 ** e));
for (const S of grid) {
  let v = 0; for (const [t, cfg] of cfgs) { const m = MK.get(t);
    applyDilution(m, cfg, S, 0, 8761, "pot"); v += grossOf(m, cfg, S, 0, 8761) - costFlat(t, cfg, S); }
  const cap = S * cfgs.size;
  if (v > best.v) best = { S, v, cap };
  if ([1995, 2512, 3162, 3981, 10000].some((x) => Math.abs(S / x - 1) < 0.02)) console.log(`${String("$"+S).padStart(12)} | ${$(cap).padStart(10)} | ${$(v).padStart(11)}`);
}
console.log(`ЛУЧШИЙ ЕДИНЫЙ: $${best.S} на рынок, капитал ${$(best.cap)}, ${$(best.v)} в год, APR ${(100*best.v/best.cap).toFixed(2)}%`);
// полнота данных
let n = 0, bad = 0;
for (const t of TOKS) { const m = MK.get(t); for (let i = 0; i < 8761; i++) { n++; if (!m.ok[i]) bad++; } }
console.log(`часов всего ${n}, без валидных баз OI ${bad} (${(100*bad/n).toFixed(3)}%)`);
// БЕЗ разбавления вообще (для масштаба эффекта)
{ let v = 0; const S = best.S;
  for (const [t, cfg] of cfgs) { const m = MK.get(t); resetRows(m, cfg, 0, 8761);
    v += grossOf(m, cfg, S, 0, 8761) - costFlat(t, cfg, S); }
  console.log(`тот же размер БЕЗ разбавления: ${$(v)} в год (разбавление съедает ${$(v - best.v)})`); }
