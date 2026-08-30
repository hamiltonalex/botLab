import { APP as STUDY_APP } from "./paths.mjs";
// mech1: устойчивость выбора A/B и наличие заглядывания вперёд.
// Все правила вызываются из движка: parseSpreadCsv, scanTwoLeg.
import { readFileSync } from "node:fs";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { scanTwoLeg } from "../../src/engine/math.js";

const DIR = STUDY_APP+"/test/fixtures";
const ASSETS = ["APT", "BTC", "ETH"];

for (const a of ASSETS) {
  const rows = parseSpreadCsv(readFileSync(`${DIR}/${a}.csv`, "utf8"));
  const full = scanTwoLeg(rows, { token: a }, { minRows: 24 });
  console.log(`\n=== ${a} === rows=${rows.length} first=${rows[0].ts} last=${rows[rows.length-1].ts}`);
  console.log(`  полная выборка: chosen=${full.chosen} meanA=${(full.meanA*100).toFixed(2)}% meanB=${(full.meanB*100).toFixed(2)}% |A-B|=${(Math.abs(full.meanA-full.meanB)*100).toFixed(2)}пп`);

  for (const win of [24, 168, 720]) {
    let agree = 0, n = 0, flips = 0, prev = null;
    for (let i = win; i <= rows.length; i++) {
      const s = scanTwoLeg(rows.slice(i - win, i), { token: a }, { minRows: 6 });
      if (!s) continue;
      n++;
      if (s.chosen === full.chosen) agree++;
      if (prev && prev !== s.chosen) flips++;
      prev = s.chosen;
    }
    console.log(`  хвост ${win}ч: совпал с полной выборкой ${(100*agree/n).toFixed(1)}% часов (${agree}/${n}), переключений конфига: ${flips}`);
  }
  // расширяющееся окно (как в живом приложении: вся накопленная история до текущего часа)
  let agreeE = 0, nE = 0, flipsE = 0, prevE = null, firstAgreeTs = null;
  for (let i = 24; i <= rows.length; i += 24) {
    const s = scanTwoLeg(rows.slice(0, i), { token: a }, { minRows: 24 });
    if (!s) continue;
    nE++;
    if (s.chosen === full.chosen) { agreeE++; if (firstAgreeTs === null) firstAgreeTs = rows[i-1].ts; }
    else firstAgreeTs = null;
    if (prevE && prevE !== s.chosen) flipsE++;
    prevE = s.chosen;
  }
  console.log(`  расширяющееся окно (шаг сутки): совпало ${(100*agreeE/nE).toFixed(1)}% (${agreeE}/${nE}), переключений: ${flipsE}, устойчиво совпадает с ${firstAgreeTs}`);
}
