import { APP as STUDY_APP } from "./paths.mjs";
// Разложение недобора вне выборки: сколько съела ротация, сколько неверная сторона.
// Плюс "честный одиночный вход": конфиг из предыдущих W суток, держать до конца, один круг.
import { readFileSync } from "node:fs";
const ENG = STUDY_APP+"/src/engine";
const { parseSpreadCsv } = await import(`${ENG}/format.js`);
const { scanTwoLeg } = await import(`${ENG}/math.js`);
const { DEFAULT_COSTS, roundTripCost } = await import(`${ENG}/costs.js`);
const { openPosition, accrueFromRows, closePosition, positionSummary } = await import(`${ENG}/paper.js`);
const FIX = STUDY_APP+"/test/fixtures";
const CAP = 2000, LEV = 1;
const RT = roundTripCost(DEFAULT_COSTS, CAP * LEV, false);
const d = (x) => (x >= 0 ? "+" : "-") + "$" + Math.abs(x).toFixed(2);
const p = (x) => (x * 100).toFixed(2) + "%";

function grossOf(rows, i, hours, cfg) {
  const lastIdx = Math.min(rows.length - 1, i + hours - 1);
  const endMs = (rows[lastIdx].tsHour + 3600) * 1000;
  const pos = openPosition({ strategy: "two", instrumentKey: "WF", config: cfg, capital: CAP, leverage: LEV, nowMs: rows[i].tsHour * 1000, roundTripCost: RT });
  accrueFromRows(pos, rows.slice(i, lastIdx + 1), endMs);
  closePosition(pos, endMs);
  return { g: positionSummary(pos).grossPnl, n: positionSummary(pos).netPnl, lastIdx };
}

const data = {};
for (const t of ["APT", "BTC", "ETH"]) data[t] = parseSpreadCsv(readFileSync(`${FIX}/${t}.csv`, "utf8"));

console.log("=== РАЗЛОЖЕНИЕ: БРУТТО ВНЕ ВЫБОРКИ / БРУТТО ОРАКУЛА / ИЗДЕРЖКИ РОТАЦИИ ===");
console.log("| токен | W | H | брутто вне выборки | брутто оракула | цена неверной стороны | издержки ротации | нетто |");
console.log("|---|---|---|---|---|---|---|---|");
const rowsOut = [];
for (const tok of ["APT", "BTC", "ETH"]) {
  const rows = data[tok];
  for (const W of [30, 60, 90, 180]) {
    const i0 = W * 24;
    for (const H of [7, 30, 90]) {
      const hh = H * 24;
      let gWf = 0, gOr = 0, k = 0;
      for (let i = i0; i < rows.length; ) {
        const train = rows.slice(Math.max(0, i - i0), i);
        const cfgWf = scanTwoLeg(train, {}).chosen;
        const lastIdx = Math.min(rows.length - 1, i + hh - 1);
        const cfgOr = scanTwoLeg(rows.slice(i, lastIdx + 1), {}, { minRows: 1 }).chosen;
        gWf += grossOf(rows, i, hh, cfgWf).g;
        gOr += grossOf(rows, i, hh, cfgOr).g;
        k++;
        i = lastIdx + 1;
      }
      const cost = k * RT;
      rowsOut.push({ tok, W, H, gWf, gOr, cost, k });
      console.log(`| ${tok} | ${W} | ${H} | ${d(gWf)} | ${d(gOr)} | ${d(gWf - gOr)} | -$${cost.toFixed(2)} | ${d(gWf - cost)} |`);
    }
  }
}

console.log("\n=== ЧЕСТНЫЙ ОДИНОЧНЫЙ ВХОД (конфиг из предыдущих W суток, держать до конца года, ОДИН круг) ===");
console.log("| токен | W | конфиг честный | конфиг задним числом | совпал | нетто честный | нетто задним числом | цена заглядывания |");
console.log("|---|---|---|---|---|---|---|---|");
for (const tok of ["APT", "BTC", "ETH"]) {
  const rows = data[tok];
  for (const W of [30, 60, 90, 180]) {
    const i0 = W * 24;
    const cfgHonest = scanTwoLeg(rows.slice(0, i0), {}).chosen;
    const cfgHind = scanTwoLeg(rows.slice(i0), {}).chosen;
    const span = rows.length - i0;
    const h = grossOf(rows, i0, span, cfgHonest);
    const hi = grossOf(rows, i0, span, cfgHind);
    console.log(`| ${tok} | ${W} | ${cfgHonest} | ${cfgHind} | ${cfgHonest === cfgHind ? "да" : "НЕТ"} | ${d(h.n)} (${p((h.n / CAP) * (8760 / span))}) | ${d(hi.n)} | ${d(h.n - hi.n)} |`);
  }
}

// Устойчивость выбора вне выборки: доля часов, где скользящий выбор совпал с годовым
console.log("\n=== СВОДКА BTC+ETH: брутто вне выборки против нуля ===");
for (const W of [30, 60, 90, 180]) for (const H of [7, 30, 90]) {
  const a = rowsOut.find(r=>r.tok==="BTC"&&r.W===W&&r.H===H), b = rowsOut.find(r=>r.tok==="ETH"&&r.W===W&&r.H===H);
  console.log(`W=${W} H=${H}: брутто ${d(a.gWf+b.gWf)} | брутто оракула ${d(a.gOr+b.gOr)} | издержки -$${(a.cost+b.cost).toFixed(2)} | нетто ${d(a.gWf+b.gWf-a.cost-b.cost)}`);
}
