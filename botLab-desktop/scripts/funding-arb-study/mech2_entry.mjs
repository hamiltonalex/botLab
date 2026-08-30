import { APP as STUDY_APP } from "./paths.mjs";
// mech2: сверка базы + цена выбора конфигурации по хвосту против выбора по всей выборке.
// Начисление делает ТОЛЬКО движок: openPosition/accrueFromRows/positionSummary, издержки roundTripCost.
import { readFileSync } from "node:fs";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { scanTwoLeg } from "../../src/engine/math.js";
import { openPosition, accrueFromRows, closePosition, positionSummary } from "../../src/engine/paper.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";

const DIR = STUDY_APP+"/test/fixtures";
const CAP = 2000, LEV = 1;
const rt = roundTripCost(DEFAULT_COSTS, CAP * LEV, false);

function run(rows, startIdx, cfg) {
  const t0 = rows[startIdx].tsHour * 1000;
  const endMs = rows[rows.length - 1].tsHour * 1000 + 3600 * 1000;
  const p = openPosition({ strategy: "two", instrumentKey: "X", config: cfg, capital: CAP, leverage: LEV, nowMs: t0, roundTripCost: rt });
  const res = accrueFromRows(p, rows, endMs);
  closePosition(p, endMs);
  return { s: positionSummary(p), hours: res.hoursApplied, gap: res.gapSkippedSec };
}

for (const a of ["APT", "BTC", "ETH"]) {
  const rows = parseSpreadCsv(readFileSync(`${DIR}/${a}.csv`, "utf8"));
  const full = scanTwoLeg(rows, {}, { minRows: 24 });
  console.log(`\n=== ${a} ===  выбор по всей выборке: ${full.chosen}`);
  for (const cfg of ["A", "B"]) {
    const r = run(rows, 0, cfg);
    console.log(`  вход в первый час, конфиг ${cfg}: брутто ${r.s.grossPnl.toFixed(2)} нетто ${r.s.netPnl.toFixed(2)} часов ${r.hours} пропущено ${r.gap}с`);
  }
  // Ежедневные точки входа: конфиг берётся из ХВОСТА (как отдаёт живое приложение) и замораживается.
  for (const win of [24, 168, 720]) {
    let sumTail = 0, sumOracle = 0, n = 0, diff = 0;
    for (let i = win; i + 24 <= rows.length; i += 24) {
      const tail = scanTwoLeg(rows.slice(i - win, i), {}, { minRows: 6 });
      if (!tail) continue;
      const rT = run(rows, i, tail.chosen);
      const rO = run(rows, i, full.chosen);
      sumTail += rT.s.netPnl; sumOracle += rO.s.netPnl; n++;
      if (tail.chosen !== full.chosen) diff++;
    }
    console.log(`  вход по хвосту ${win}ч, держать до конца данных, ${n} точек входа: средний нетто $${(sumTail/n).toFixed(2)} против «оракула» $${(sumOracle/n).toFixed(2)} (разрыв $${((sumTail-sumOracle)/n).toFixed(2)}), расхождений выбора ${diff}/${n}`);
  }
}
