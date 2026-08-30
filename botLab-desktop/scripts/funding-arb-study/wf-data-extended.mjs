import { APP as STUDY_APP } from "./paths.mjs";
// wf-data-extended.mjs - тот же движок на записи ДЛИННЕЕ фикстуры. Только чтение.
//
// Источник: gmx_carry_backtest/data/cache/eth_hourly_<market>_1695319200_1781719200.csv, 23911 часов
// (2023-09-25 .. 2026-06-17) против 8761 в фикстуре. Столбцы funding_factor_short /
// borrow_factor_short по шапке loader.py уже поделены на 1e30 и в том же знаке, что f_short/b_short
// движка (">0 => short receives"). Двухногую отсюда посчитать нельзя (нет hl_rate и длинной ноги),
// поэтому меряется ОДНОНОГАЯ через scanOneLeg - ровно та функция, что и на фикстуре.

import { readFileSync } from "node:fs";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { scanOneLeg, pnlPath, maxDrawdownFraction, mean } from "../../src/engine/math.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";
import { nEff, ci95 } from "../../src/engine/otmscan/stats.js";

const LONG = "/Users/alexhamilton/GITFILES/hamiltonalex/funding-rate-arbitrage-backtesting/gmx_carry_backtest/data/cache/eth_hourly_0x70d95587d40A2caf56bd97485aB3Eec10Bee6336_1695319200_1781719200.csv";
const FIXT = STUDY_APP+"/test/fixtures/ETH.csv";
const NOTIONAL = 2000;
const fin = (x) => Number.isFinite(x);
const f = (x, d = 4) => (fin(x) ? x.toFixed(d) : "n/a");
const pct = (x, d = 1) => (fin(x) ? (x * 100).toFixed(d) + "%" : "n/a");

// Читаем длинный файл в форму строк движка. Переименование столбцов, не пересчёт.
const raw = readFileSync(LONG, "utf8").split(/\r?\n/).filter((l) => l.length);
const hdr = raw[0].split(",");
const iTs = hdr.indexOf("ts");
const iF = hdr.indexOf("funding_factor_short");
const iB = hdr.indexOf("borrow_factor_short");
const long = [];
for (let i = 1; i < raw.length; i++) {
  const p = raw[i].split(",");
  const ts = p[iTs];
  const ms = Date.parse(ts.replace(" ", "T"));
  long.push({
    ts,
    tsHour: Math.floor(ms / 1000 / 3600) * 3600,
    f_short: parseFloat(p[iF]),
    b_short: parseFloat(p[iB]),
    f_long: NaN, // длинной ноги в этом кэше нет; scanOneLeg её не читает
    b_long: NaN,
    hl_rate: NaN,
  });
}

console.log("## 1 · Длинная запись против фикстуры\n");
console.log(`Файл: ${LONG.split("/").pop()}`);
console.log(`Часов: ${long.length} (${(long.length / 8760).toFixed(2)} года), ${long[0].ts} .. ${long[long.length - 1].ts}`);
console.log(`Фикстура ETH.csv: 8761 час (1.00 года).`);
let gaps = 0;
for (let i = 1; i < long.length; i++) if (long[i].tsHour - long[i - 1].tsHour !== 3600) gaps += 1;
console.log(`Разрывов в часовой сетке длинного файла: ${gaps}.`);

// Сверка перекрытия: одноногая на общем годе должна совпасть с фикстурой
const fix = parseSpreadCsv(readFileSync(FIXT, "utf8"));
const fixFrom = fix[0].tsHour, fixTo = fix[fix.length - 1].tsHour;
const overlap = long.filter((r) => r.tsHour >= fixFrom && r.tsHour <= fixTo);
const oneOverlap = scanOneLeg(overlap, { token: "ETH" });
const oneFix = scanOneLeg(fix, { token: "ETH" });
console.log("\n## 2 · Сверка источников на общем окне (одноногая ETH)\n");
console.log(`| источник | часов | среднее APR | брутто $ на ${NOTIONAL} |`);
console.log(`|---|---|---|---|`);
console.log(`| фикстура botLab | ${oneFix.hours} | ${f(oneFix.netMean)} | ${f(pnlPath(oneFix.net, NOTIONAL).total, 2)} |`);
console.log(`| длинный кэш (то же окно) | ${oneOverlap.hours} | ${f(oneOverlap.netMean)} | ${f(pnlPath(oneOverlap.net, NOTIONAL).total, 2)} |`);

// ── по годам
console.log("\n## 3 · Одноногая ETH по годам (scanOneLeg, $2000, круг по DEFAULT_COSTS)\n");
console.log(`| окно | часов | среднее APR | медиана APR | доля + часов | смен знака | брутто $ | нетто $ | просадка $ | n_eff | ±95% APR | ноль в полосе? |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
const YEAR = 8760;
const windows = [];
for (let start = long.length; start - YEAR >= 0; start -= YEAR) windows.push([start - YEAR, start]);
windows.reverse();
// остаток в начале, если он есть
if (windows.length && windows[0][0] > 0) windows.unshift([0, windows[0][0]]);
const rowsOut = [];
for (const [a, b] of windows) {
  const seg = long.slice(a, b);
  if (seg.length < 24) continue;
  const one = scanOneLeg(seg, { token: "ETH" });
  const gross = pnlPath(one.net, NOTIONAL).total;
  const netUsd = gross - roundTripCost(DEFAULT_COSTS, NOTIONAL, true);
  const ne = nEff(one.net);
  const band = ci95(one.net);
  const inside = fin(band) ? Math.abs(one.netMean) < band : null;
  rowsOut.push({ one, gross, netUsd });
  console.log(
    `| ${seg[0].ts.slice(0, 10)} .. ${seg[seg.length - 1].ts.slice(0, 10)} | ${one.hours} | ${f(one.netMean)} | ${f(one.netMedian)} | ${pct(one.pctPos)} | ${one.flips} | ${f(gross, 2)} | ${f(netUsd, 2)} | ${f(maxDrawdownFraction(one.net) * NOTIONAL, 2)} | ${f(ne, 1)} | ${f(band)} | ${inside === null ? "n/a" : inside ? "ДА" : "нет"} |`,
  );
}
const all = scanOneLeg(long, { token: "ETH" });
const allGross = pnlPath(all.net, NOTIONAL).total;
console.log(
  `| **вся запись** | ${all.hours} | ${f(all.netMean)} | ${f(all.netMedian)} | ${pct(all.pctPos)} | ${all.flips} | ${f(allGross, 2)} | ${f(allGross - roundTripCost(DEFAULT_COSTS, NOTIONAL, true), 2)} | ${f(maxDrawdownFraction(all.net) * NOTIONAL, 2)} | ${f(nEff(all.net), 1)} | ${f(ci95(all.net))} | ${Math.abs(all.netMean) < ci95(all.net) ? "ДА" : "нет"} |`,
);

// ── по кварталам, чтобы увидеть разброс режимов
console.log("\n## 4 · Разброс между кварталами (одноногая ETH)\n");
const Q = 2190;
const qAprs = [];
for (let s = long.length; s - Q >= 0; s -= Q) {
  const seg = long.slice(s - Q, s);
  const one = scanOneLeg(seg, { token: "ETH" });
  qAprs.push({ from: seg[0].ts.slice(0, 10), apr: one.netMean, usd: pnlPath(one.net, NOTIONAL).total });
}
qAprs.reverse();
console.log(`Кварталов: ${qAprs.length}. Средние APR по кварталам:`);
console.log(qAprs.map((x) => `${x.from} ${f(x.apr, 3)}`).join(" | "));
const pos = qAprs.filter((x) => x.apr > 0).length;
console.log(`Кварталов с положительным средним: ${pos} из ${qAprs.length}.`);
console.log(`Разброс: min ${f(Math.min(...qAprs.map((x) => x.apr)))}, max ${f(Math.max(...qAprs.map((x) => x.apr)))}, среднее ${f(mean(qAprs.map((x) => x.apr)))}.`);
console.log(`Годовой замер по фикстуре (ETH one, весь год) = ${f(oneFix.netMean)}. Он попадает ${
  oneFix.netMean >= Math.min(...qAprs.map((x) => x.apr)) && oneFix.netMean <= Math.max(...qAprs.map((x) => x.apr)) ? "внутрь" : "вне"
} квартального разброса.`);
