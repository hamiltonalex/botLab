// pf-1-run.mjs - ГЛАВНЫЙ ЗАМЕР ГИПОТЕЗЫ ПОРТФЕЛЯ. READ-ONLY.
//
// ПОРЯДОК ЗДЕСЬ ВАЖЕН И ОН НЕ СЛУЧАЕН. Сначала СВЕРКА стенда с опубликованными числами замера
// правила выхода (режим длины "theirs"), и только потом ответ на вопрос (режим "equal"). Стенд,
// который не воспроизводит чужое число, не имеет права публиковать своё.

import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { q, $, H } from "./pf-lib.mjs";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const SCAN = argOf("--scan");
const CAPITAL = Number(argOf("--capital", 5000));
const CADENCE = Number(argOf("--cadence", 24));
const STARTS = Number(argOf("--starts", 12));
const STEP = Number(argOf("--step", 60));

const scan = loadScan(SCAN);
const env = makeEnv();
const YEAR = env.YEAR;
const LAST_FIRST = H + (STARTS - 1) * STEP;
const EQUAL_LEN = YEAR - LAST_FIRST; // длина, которая влезает у САМОГО ПОЗДНЕГО старта

console.log(`# Гипотеза портфеля: несколько рынков сразу против одного\n`);
console.log(`Вселенная ${env.markets.length} рынков, год ${YEAR} ч, горизонт ${H} ч, капитал $${CAPITAL},`);
console.log(`каданс ${CADENCE} ч, ${STARTS} стартов со сдвигом ${STEP} ч.\n`);
console.log(`ДЛИНА ПРОГОНА. Стенд замера правила выхода сдвигал НАЧАЛО и держал КОНЕЦ, отчего`);
console.log(`последний старт короче первого на ${(STARTS - 1) * STEP} ч. Здесь это режим "theirs" и он нужен`);
console.log(`только для сверки. Ответ даёт режим "equal", где все старты идут по ${EQUAL_LEN} ч.\n`);

const MODES = ["hold-1", "hold-pf", "rule-1", "rule-pf"];

function series(mode, lenMode, kmax = Infinity, capital = CAPITAL, cadence = CADENCE) {
  const out = [];
  for (let s = 0; s < STARTS; s += 1) {
    const first = H + s * STEP;
    const last = lenMode === "equal" ? first + EQUAL_LEN : YEAR;
    out.push(walk({ scan, env, capital, cadence, kmax, mode, first, last }));
  }
  return out;
}

const setsOf = (r) => r.log.filter((e) => e.act === "set");
const posOf = (r) => { const s = setsOf(r); return s.length ? q(s.map((e) => e.n), 0.5) : 0; };
const usdOf = (r) => { const s = setsOf(r); return s.length ? q(s.map((e) => e.usd), 0.5) : 0; };

for (const lenMode of ["theirs", "equal"]) {
  console.log(`\n## Режим длины: ${lenMode}\n`);
  console.log(`| рука | медиана нетто | мин | макс | позиций | задействовано | кругов | решений |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  for (const mode of MODES) {
    const rs = series(mode, lenMode);
    const nets = rs.map((r) => r.net);
    const trips = rs.map((r) => r.tally.open);
    console.log(`| ${mode} | ${$(q(nets, 0.5))} | ${$(Math.min(...nets))} | ${$(Math.max(...nets))} | ${q(rs.map(posOf), 0.5).toFixed(1)} | ${$(q(rs.map(usdOf), 0.5))} | ${q(trips, 0.5).toFixed(0)} | ${rs[0].decisions} |`);
  }
}

// ── РАЗЛИЧНЫЕ ПЕРВЫЕ РЫНКИ. Если у hold-1 их два-три, его размах мин-макс это не 12 наблюдений,
// а два-три числа с кратностями, и подавать его как распределение нельзя.
console.log(`\n## Состав: сколько РАЗЛИЧНЫХ рынков попадает в руки\n`);
for (const mode of ["hold-1", "hold-pf"]) {
  const rs = series(mode, "equal");
  const firsts = rs.map((r) => (r.log.find((e) => e.act === "set") || {}).tokens || "н-д");
  const uniq = [...new Set(firsts)];
  console.log(`${mode}: РАЗЛИЧНЫХ стартовых составов ${uniq.length} из ${STARTS}`);
  for (const u of uniq) console.log(`   ${firsts.filter((x) => x === u).length}x  ${u}`);
}
