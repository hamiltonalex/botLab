// hlc-v-5: ХЕДЖ ЛОНГОМ ПЕРПА BINANCE. Обе ноги считает движок правилом почасового расчёта HL
// (ставка Binance в кэше уже приведена к часу: 8-часовая /8), синтетические строки изолируют ногу.
import { DEFAULT_COSTS, roundTripCost, all, YEAR } from "./skept-cap-lib.mjs";
import { parseMv, runLegs, hourlyOnlyRows, ann } from "./hlc-v-lib.mjs";

const N = 10000;
// круг для пары HL+Binance: тейкер Binance USDs-M 0.05% за сторону, без импакта и без газа,
// нога HL по штатной модели (0.045% x 2). Вызывается та же roundTripCost, меняются параметры.
const BIN_COSTS = { ...DEFAULT_COSTS, gmxOpen: 0.05, gmxClose: 0.05, gmxImpact: 0, gmxGas: 0 };
const rtBin = roundTripCost(BIN_COSTS, N, false);
const rtGmx = roundTripCost(DEFAULT_COSTS, N, false);
// спот на HL: тейкер спота 0.070% x 2 сторон + перп 0.045% x 2
const SPOT_COSTS = { ...DEFAULT_COSTS, gmxOpen: 0.07, gmxClose: 0.07, gmxImpact: 0, gmxGas: 0 };
const rtSpot = roundTripCost(SPOT_COSTS, N, false);

const files = { BTC: "mv_btc_1688616000_1781726400.csv", ETH: "mv_eth_1688616000_1781726400.csv" };
console.log(`Ноциональ ноги $${N}. Круг двух ног: HL+GMX $${rtGmx.toFixed(2)} (${(100 * rtGmx / N).toFixed(3)}%), HL+Binance $${rtBin.toFixed(2)} (${(100 * rtBin / N).toFixed(3)}%), HL перп+HL спот $${rtSpot.toFixed(2)} (${(100 * rtSpot / N).toFixed(3)}%)\n`);

for (const [tok, f] of Object.entries(files)) {
  const mv = parseMv(f);
  const windows = {
    "весь ряд 2023-07..2026-06": mv,
    "год кэша 2025-06..2026-06": mv.filter((r) => r.tsHour >= all.get(tok)[0].tsHour),
  };
  console.log(`=== ${tok}`);
  for (const [wname, w] of Object.entries(windows)) {
    // нога керри: ШОРТ перпа HL
    const hlLeg = runLegs({ rows: hourlyOnlyRows(w.map((r) => [r.tsHour, r.ns_hl])), config: "B", notional: N, rtCost: 0 });
    // нога хеджа: ЛОНГ перпа Binance. Шорт Binance получает +ns_bin => лонг получает -ns_bin.
    const binLeg = runLegs({ rows: hourlyOnlyRows(w.map((r) => [r.tsHour, -r.ns_bin])), config: "B", notional: N, rtCost: 0 });
    // нога хеджа: СПОТ (фандинга нет вовсе) -> нулевая ставка, оставлена явно для симметрии
    const spotLeg = runLegs({ rows: hourlyOnlyRows(w.map((r) => [r.tsHour, 0])), config: "B", notional: N, rtCost: 0 });
    const h = hlLeg.hours;
    const P = (x) => (100 * ann(x, N, h)).toFixed(2).padStart(7);
    const netBin = hlLeg.hl + binLeg.hl - rtBin;
    const netSpot = hlLeg.hl + spotLeg.hl - rtSpot;
    console.log(`  ${wname}  (${w.length} ч, ${(h / 8760).toFixed(2)} года)`);
    console.log(`    керри шорт HL          ${P(hlLeg.hl)}%   $${hlLeg.hl.toFixed(0)}`);
    console.log(`    хедж лонг Binance      ${P(binLeg.hl)}%   $${binLeg.hl.toFixed(0)}`);
    console.log(`    хедж спот (фандинга 0) ${P(spotLeg.hl)}%   $${spotLeg.hl.toFixed(0)}`);
    console.log(`    круг Binance ${(-100 * ann(rtBin, N, h)).toFixed(2)}%/год  ЧИСТО HL+Binance ${P(netBin)}%  $${netBin.toFixed(0)}  (на капитал двух ног ${(100 * ann(netBin, 2 * N, h)).toFixed(2)}%)`);
    console.log(`    круг спот    ${(-100 * ann(rtSpot, N, h)).toFixed(2)}%/год  ЧИСТО HL+спот    ${P(netSpot)}%  $${netSpot.toFixed(0)}  (на капитал двух ног ${(100 * ann(netSpot, 2 * N, h)).toFixed(2)}%)`);
    const better = w.filter((r) => r.ns_hl > r.ns_bin).length;
    console.log(`    часов где ставка HL выше Binance: ${better}/${w.length} = ${(100 * better / w.length).toFixed(1)}%`);
  }
  console.log("");
}
