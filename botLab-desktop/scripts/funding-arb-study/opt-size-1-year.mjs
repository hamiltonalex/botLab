// Сетка по размеру, режим «держим год», конфиг выбирает движок на всём годе (постановка,
// которой получены прежние $3162/$9507). Пишем разбор на ноги: без него оптимум читается неверно.
import fs from "node:fs";
import { MK, TOKS, SIZES, applyDilution, grossParts, scanTwoLeg, SP } from "./opt-size-lib.mjs";
const out = {}; const t0 = Date.now();
for (const t of TOKS) {
  const m = MK.get(t);
  const cfg = scanTwoLeg(m.rows, { token: t }).chosen;
  const o = { cfg, pot: [], potF: [], potB: [], potH: [], flip: [] };
  for (const S of SIZES) {
    applyDilution(m, cfg, S, 0, 8761, "pot");
    const d = grossParts(m, cfg, S, 0, 8761);
    o.pot.push(d.g); o.potF.push(d.f); o.potB.push(d.b); o.potH.push(d.h);
    applyDilution(m, cfg, S, 0, 8761, "flip");
    o.flip.push(grossParts(m, cfg, S, 0, 8761).g);
  }
  out[t] = o; process.stdout.write(".");
}
fs.writeFileSync(`${SP}/opt-size-year.json`, JSON.stringify({ SIZES, out }));
console.log(`\nготово за ${((Date.now()-t0)/1000).toFixed(0)} с`);
