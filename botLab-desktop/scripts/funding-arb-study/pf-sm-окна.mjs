// pf-sm-окна.mjs - НАДЁЖНОСТЬ НА КОРОТКИХ СРОКАХ. READ-ONLY.
//
// ПОСТАНОВКА. Депозит связан СВЕРХУ внешней причиной: большую маржу боту не дадут, пока он себя не
// показал. Значит у прогона две цели сразу, заработать и ДОКАЗАТЬ, и вторая упирается не в годовой
// процент, а в вопрос «за какой срок результат перестаёт быть монеткой». Годовая цифра тут вообще
// не отвечает: если из месяцев в плюсе только 70%, то каждый третий месяц показа даст убыток, и
// как доказательство механизма такой прогон не годится, каким бы ни было среднее.
//
// ЧТО СЧИТАЕТСЯ. Скользящее окно фиксированной длины, старт каждые 24 ч по всему году, и по каждой
// клетке (длина x капитал x рука) четыре числа: медиана нетто, ДОЛЯ ОКОН В ПЛЮСЕ, 10-й процентиль
// и худшее окно. Доля в плюсе тут главная: она прямо отвечает на вопрос владельца, а медиана нет.
//
// ГРАНИЦА ОКНА, И ОНА ВЫСТАВЛЕНА НАМЕРЕННО НА `first + L - 1`, А НЕ НА `first + L`. Ходок принимает
// решение и в час `end` тоже (`for (t = first; t <= end; t += cadence)`), а начисляет до `end` же.
// При длине, кратной кадансу, решение легло бы РОВНО на закрывающий час: рука rule-1 могла бы там
// переложиться, заплатив полный круг ($4.10 на депозит $1000) и не получив ни часа начисления.
// На четырнадцатидневном окне это артефакт замера размером с сам результат, и бил бы он только по
// одной из двух рук. Сдвиг на час убирает решение с границы; ценой уходит один час начисления из
// 336..4320, то есть 0.3% и меньше, и уходит он у ОБЕИХ рук одинаково.
//
// ЧЕГО ЗДЕСЬ НЕТ. Окна ПЕРЕКРЫВАЮТСЯ и год ОДИН, поэтому «доля в плюсе» описывает этот
// конкретный год, а не вероятность на будущем годе. Независимых месяцев в году двенадцать, а не
// триста, и доверительный интервал доли отсюда НЕ считается. Это сказано в отчёте прямым текстом.
import fs from "node:fs";
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H, q, $ } from "./pf-lib.mjs";

const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const nums = (s) => s.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));

const scan = loadScan(argOf("--scan"));
const env = makeEnv();
const YEAR = env.YEAR;                       // 8761, последний доступный час
const DAYS = nums(argOf("--lens", "14,30,60,90,180"));
const CAPS = nums(argOf("--caps", "1000,3000"));
const MODES = (argOf("--modes", "hold-1,rule-1")).split(",");
const CAD = Number(argOf("--cadence", 24));
const STEP = Number(argOf("--step", 24));    // шаг старта окна
const OUT = argOf("--json", null);

const mean = (a) => (a.length ? a.reduce((u, v) => u + v, 0) / a.length : NaN);

// Старты окна длины L: год начинается с часа H=720 (раньше нет трейлинга) и кончается на YEAR.
function startsFor(L) {
  const out = [];
  for (let first = H; first + L - 1 <= YEAR; first += STEP) out.push(first);
  return out;
}

const cells = [];
const t0 = Date.now();
for (const d of DAYS) {
  const L = d * 24;
  const starts = startsFor(L);
  for (const capital of CAPS) {
    for (const mode of MODES) {
      const net = [];
      const opens = [];
      for (const first of starts) {
        const r = walk({ scan, env, capital, cadence: CAD, mode, first, last: first + L - 1 });
        net.push(r.net);
        opens.push(r.tally.open);
      }
      const pos = net.filter((x) => x > 0).length;
      const zero = net.filter((x) => x === 0).length;
      cells.push({
        days: d, hours: L, capital, mode, n: net.length,
        median: q(net, 0.5), mean: mean(net), share: pos / net.length, posCount: pos, zeroCount: zero,
        p10: q(net, 0.1), p25: q(net, 0.25), p90: q(net, 0.9),
        worst: Math.min(...net), best: Math.max(...net),
        medOpens: q(opens, 0.5),
        annPctMedian: (100 * q(net, 0.5) * (8760 / L)) / capital,
      });
      process.stderr.write(`  ${d}d ${mode} $${capital}: n=${net.length} med=${q(net, 0.5).toFixed(2)} плюс=${(100 * pos / net.length).toFixed(1)}%  (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
    }
  }
}

console.log(`# Надёжность на коротких сроках: скользящие окна\n`);
console.log(`Год 2025-06..2026-06, часы ${H}..${YEAR}, вселенная 63 рынка, каданс ${CAD} ч, старт окна каждые ${STEP} ч.`);
console.log(`Окно = [first, first+L-1], решение на закрывающий час НЕ приходится (см. шапку файла).\n`);
console.log(`| срок | капитал | рука | окон | медиана нетто | ДОЛЯ В ПЛЮСЕ | p10 | ХУДШЕЕ | среднее | p90 | лучшее | % годовых по медиане |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
for (const c of cells) {
  console.log(`| ${c.days} сут | $${c.capital} | ${c.mode} | ${c.n} | $${c.median.toFixed(2)} | **${(100 * c.share).toFixed(1)}%** | $${c.p10.toFixed(2)} | $${c.worst.toFixed(2)} | $${c.mean.toFixed(2)} | $${c.p90.toFixed(2)} | $${c.best.toFixed(2)} | ${c.annPctMedian.toFixed(1)}% |`);
}

console.log(`\n## Минимальный срок по порогу доли в плюсе\n`);
console.log(`| капитал | рука | >=90% | >=95% |`);
console.log(`|---|---|---|---|`);
for (const capital of CAPS) {
  for (const mode of MODES) {
    const row = cells.filter((c) => c.capital === capital && c.mode === mode).sort((a, b) => a.days - b.days);
    const firstAt = (thr) => { const hit = row.find((c) => c.share >= thr); return hit ? `${hit.days} сут (${(100 * hit.share).toFixed(1)}%)` : "НЕТ на замеренных сроках"; };
    console.log(`| $${capital} | ${mode} | ${firstAt(0.9)} | ${firstAt(0.95)} |`);
  }
}

if (OUT) { fs.writeFileSync(OUT, JSON.stringify({ meta: { H, YEAR, CAD, STEP, DAYS, CAPS, MODES }, cells }, null, 2)); process.stderr.write(`\nJSON: ${OUT}\n`); }
process.stderr.write(`\nвсего ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
