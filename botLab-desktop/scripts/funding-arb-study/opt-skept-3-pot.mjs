// Скептик 3. НАСЫЩЕНИЕ КОТЛОМ + разбор ног в точке S*.
import fs from "node:fs";
import { MK, applyDilution, grossParts, costEmp, $, SP, gmxImpactBps, hlSlipBps } from "./opt-size-lib.mjs";
const o = JSON.parse(fs.readFileSync(`${SP}/opt-skept-2.json`, "utf8")).sort((a, b) => b.vStar - a.vStar);
console.log("рынок cfg |        S* |    нетто | GMXfund | GMXborrow |   HLfund | издержки | котёл(год) | наш/котёл | доля S*>500k");
let sumOverPot = 0, nOverPot = 0;
for (const x of o.slice(0, 16)) {
  const m = MK.get(x.t), S = x.sStar;
  applyDilution(m, x.cfg, S, 0, 8761, "pot");
  const p = grossParts(m, x.cfg, S, 0, 8761);
  const c = costEmp(x.t, x.cfg, S);
  // весь котёл рынка за год, доллары (только часы, когда МЫ получаем)
  const short = x.cfg === "A", src = short ? m.fs_ : m.fl;
  let potAll = 0, potOurs = 0;
  for (let i = 0; i < 8761; i++) { if (!m.ok[i]) continue; potAll += m.pot[i] * 3600;
    if (src[i] > 0) potOurs += m.pot[i] * 3600; }
  const ratio = p.f / potOurs;
  if (ratio > 1) nOverPot++;
  console.log(`${x.t.padEnd(9)}${x.cfg} | ${String("$"+Math.round(S)).padStart(9)} | ${$(x.vStar).padStart(8)} | ${$(p.f).padStart(7)} | ${$(p.b).padStart(9)} | ${$(p.h).padStart(8)} | ${$(-c).padStart(8)} | ${$(potOurs).padStart(10)} | ${(100*ratio).toFixed(1).padStart(8)}% | ${S>5e5?"ЭКСТРАП":""}`);
}
console.log(`рынков, где наш фандинг GMX > котла часов получения: ${nOverPot}`);
// доля ноги HL во всём безлимитном оптимуме
let F = 0, B = 0, H = 0, N = 0;
for (const x of o) { if (!(x.vStar > 0)) continue; const m = MK.get(x.t);
  applyDilution(m, x.cfg, x.sStar, 0, 8761, "pot");
  const p = grossParts(m, x.cfg, x.sStar, 0, 8761); F += p.f; B += p.b; H += p.h; N += x.vStar; }
console.log(`\nбезлимитный оптимум целиком: GMXfund ${$(F)}, GMXborrow ${$(B)}, HLfund ${$(H)}, нетто ${$(N)}`);
console.log(`доля ноги HL в валовом положительном доходе: ${(100*H/(F+H)).toFixed(0)}%`);
// издержки HL-проскальзывания в точке S* для трёх главных
for (const x of o.slice(0, 3)) console.log(`  ${x.t}: удар GMX ${gmxImpactBps(x.t, x.cfg, x.sStar).toFixed(3)} бп, проскальзывание HL ${hlSlipBps(x.t, x.sStar).toFixed(3)} бп (последний ИЗМЕРЕННЫЙ узел $500k)`);
