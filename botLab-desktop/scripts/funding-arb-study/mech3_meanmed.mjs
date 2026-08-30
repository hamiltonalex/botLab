import { APP as STUDY_APP } from "./paths.mjs";
// mech3: выбор конфига (argmax СРЕДНЕГО) против ранжирования сканера (МЕДИАНА) - расходятся ли они.
import { readFileSync } from "node:fs";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { scanTwoLeg } from "../../src/engine/math.js";
import { buildScanner } from "../../src/engine/assemble.js";

const DIR = STUDY_APP+"/test/fixtures";
const frames = {};
for (const a of ["APT","BTC","ETH"]) frames[a] = parseSpreadCsv(readFileSync(`${DIR}/${a}.csv`, "utf8"));

const entries = {};
for (const a of ["APT","BTC","ETH"]) {
  const s = scanTwoLeg(frames[a], { token: a }, { minRows: 24 });
  const medChosen = s.A.netMedian >= s.B.netMedian ? "A" : "B";
  console.log(`${a}: chosen(mean)=${s.chosen}  chosen(median)=${medChosen}  A med=${(s.A.netMedian*100).toFixed(2)}% B med=${(s.B.netMedian*100).toFixed(2)}%  A mean=${(s.A.netMean*100).toFixed(2)}% B mean=${(s.B.netMean*100).toFixed(2)}%  ddA=${(s.A.ddPct*100).toFixed(2)}% ddB=${(s.B.ddPct*100).toFixed(2)}%  pctPosA=${(s.A.pctPos*100).toFixed(1)}% pctPosB=${(s.B.pctPos*100).toFixed(1)}%  flipsA=${s.A.signChg}`);
  entries[a] = { chosen: s.chosen, A: s.A, B: s.B, oi: null, hours: s.hours, winDays: 365 };
}
console.log("\nсканер (buildScanner, ранжирование по медиане выбранного конфига):");
for (const r of buildScanner(entries)) console.log(`  #${r.r} ${r.s} конфиг ${r.c}  med=${(r.med*100).toFixed(2)}%  mean=${(r.mean*100).toFixed(2)}%  pctPos=${(r.pct*100).toFixed(1)}%  флипов=${r.sc}  ${r.st}  часов=${r.h}`);

// как часто на скользящем хвосте argmax среднего и argmax медианы дают РАЗНЫЙ конфиг
for (const a of ["APT","BTC","ETH"]) {
  const rows = frames[a];
  for (const win of [24, 168, 720]) {
    let dis = 0, n = 0;
    for (let i = win; i <= rows.length; i += 6) {
      const s = scanTwoLeg(rows.slice(i - win, i), {}, { minRows: 6 });
      if (!s) continue;
      const medC = s.A.netMedian >= s.B.netMedian ? "A" : "B";
      n++; if (medC !== s.chosen) dis++;
    }
    console.log(`${a} хвост ${win}ч: среднее и медиана указывают на РАЗНЫЙ конфиг в ${(100*dis/n).toFixed(1)}% замеров (${dis}/${n})`);
  }
}
