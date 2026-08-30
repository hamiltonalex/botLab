// Итоговая секция curveForModel: 10 согласованных размерных узлов на сторону, из growth.pooled.
import fs from "node:fs"; import { SP } from "./imp-gmx-lib.mjs";
const J = JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`, "utf8"));
const nodes = (k) => J.growth.pooled[k].bands.map((b) => ({ band: b.band, sizeUsd: b.medSizeUsd, bps: b.medBps, meanBps: b.meanBps, adverseBps: b.p25, favourableBps: b.p75, n: b.n }));
J.curveForModel = {
  howTo: "Издержка impact для сделки размера S на стороне X: кусочно-линейная интерполяция bps по log10(sizeUsd) между узлами; за краями держать крайний узел. Знак сохранён: bps>0 значит GMX ПЛАТИТ. Доля ноционала = -bps/1e4.",
  whichToUse: "entryImpact = мгновенная цена входа, замерена до сентября 2025, когда impact ещё брался на входе; это чистая кривая impact(размер, сторона). roundTripCurrentRegime = весь impact круга в нынешнем режиме GMX (с октября 2025 вход даёт ровно ноль, всё оседает на выходе), брать ОДИН раз на круг, а не по разу на ногу.",
  short_entryImpact: nodes("preOpen_short"),   // конфиг A: шорт GMX
  long_entryImpact: nodes("preOpen_long"),     // конфиг B: лонг GMX
  short_roundTripCurrentRegime: nodes("postClose_short"),
  long_roundTripCurrentRegime: nodes("postClose_long"),
  slopesBpsPerDecade: Object.fromEntries(Object.entries(J.growth.pooled).map(([k, v]) => [k, v.slopeBpsPerDecade])),
  vs_DEFAULT_COSTS: "В модели DEFAULT_COSTS.gmxImpact = 0.001 ноционала = -10 bps на КАЖДУЮ ногу и при $600, и при $50000. Замер: на всём диапазоне $300..$5M медиана лежит между -5 и +4 bps, а на стороне шорта GMX она ПОЛОЖИТЕЛЬНА до $5M.",
  perMarketFallback: "Кривая по конкретному рынку лежит в growth.byMarket[TOKEN][вид_сторона].bands; если полоса пуста, падать на growth.pooled того же вида и стороны.",
};
fs.writeFileSync(`${SP}/impact-gmx.json`, JSON.stringify(J));
console.log("ключи верхнего уровня:", Object.keys(J).join(", "));
console.log("узлов:", Object.fromEntries(["short_entryImpact", "long_entryImpact", "short_roundTripCurrentRegime", "long_roundTripCurrentRegime"].map((k) => [k, J.curveForModel[k].length])));
console.log("рынков в markets:", Object.keys(J.markets).length, "| в growth.byMarket:", Object.keys(J.growth.byMarket).length, "| в tail.byMarket:", Object.keys(J.tail.byMarket).length);
console.log("размер файла:", (fs.statSync(`${SP}/impact-gmx.json`).size / 1e6).toFixed(2), "МБ");
// демонстрация интерполятора
const interp = (nds, s) => { const x = Math.log10(s); if (x <= Math.log10(nds[0].sizeUsd)) return nds[0].bps;
  for (let i = 1; i < nds.length; i++) { const a = nds[i - 1], b = nds[i], xa = Math.log10(a.sizeUsd), xb = Math.log10(b.sizeUsd);
    if (x <= xb) return a.bps + (b.bps - a.bps) * (x - xa) / (xb - xa); } return nds[nds.length - 1].bps; };
console.log("\nпроба интерполяции (bps, знак сохранён):");
for (const s of [600, 2000, 10000, 50000, 200000, 1e6]) console.log(`  $${s.toLocaleString("en-US").padStart(9)}  шорт GMX ${interp(J.curveForModel.short_entryImpact, s).toFixed(2).padStart(6)}   лонг GMX ${interp(J.curveForModel.long_entryImpact, s).toFixed(2).padStart(6)}   круг A ${interp(J.curveForModel.short_roundTripCurrentRegime, s).toFixed(2).padStart(6)}   круг B ${interp(J.curveForModel.long_roundTripCurrentRegime, s).toFixed(2).padStart(6)}`);
