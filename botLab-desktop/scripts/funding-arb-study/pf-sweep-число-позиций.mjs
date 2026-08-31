// pf-sweep-число-позиций.mjs - РАЗВЁРТКА ПО ЧИСЛУ ПОЗИЦИЙ kmax. READ-ONLY.
//
// ВОПРОС. Выгода портфеля растёт по числу позиций МОНОТОННО или у неё есть внутренний оптимум?
// Разбавление за рост: доход рынка равен pot*S/(B+S), и при k одинаковых рынках сумма
// C*pot/(B + C/k) растёт по k. Качество против: дробя капитал, приходится брать рынки хуже
// лучшего. Арифметикой это не решается, только замером.
//
// ЧЕГО ЗДЕСЬ НЕТ. Второго распределителя. Ограничение k накладывается НА СПИСОК КАНДИДАТОВ
// (kmax лучших по нетто), после чего зовётся тот же allocateCapital, что и всегда. Ходок не
// трогается вовсе: он импортируется из pf-walk.mjs.
//
// ПОБОЧНЫЙ ВОПРОС, КОТОРЫЙ ЗАКРЫВАЕТСЯ ТУТ ЖЕ. Сколько позиций распределитель берёт САМ, когда
// предела нет. Если сам он берёт меньше, чем даёт максимум таблицы, значит потолок капитала
// связывает раньше, чем качество, и это надо назвать.

import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { q, H } from "./pf-lib.mjs";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const SCAN = argOf("--scan");
const CAPITAL = Number(argOf("--capital", 5000));
const CADENCE = Number(argOf("--cadence", 24));
const STARTS = Number(argOf("--starts", 12));
const STEP = Number(argOf("--step", 60));
const OUT = argOf("--out", null);
// Сетка k. По умолчанию грубая; --ks задаёт свою («inf» = без предела) для уточнения вершины.
const KS_ARG = argOf("--ks", null);

const scan = loadScan(SCAN);
const env = makeEnv();
const YEAR = env.YEAR;
const LAST_FIRST = H + (STARTS - 1) * STEP;
const EQUAL_LEN = YEAR - LAST_FIRST; // длина, которая влезает у САМОГО ПОЗДНЕГО старта

// ── ПРОВЕРКА АДДИТИВНОСТИ НАЧИСЛЕНИЯ. Ходок копит брутто отрезками между точками решения. Если
// сумма отрезков не равна одному длинному начислению, начисление зависит от разбивки, и тогда
// ВСЕ числа таблицы зависят от каданса механически. Проверяется на живом рынке движком.
function additivity() {
  const probes = [];
  const from = H;
  const len = CADENCE * 20;
  for (const m of env.markets.slice(0, 8)) {
    for (const config of ["A", "B"]) {
      const one = env.grossOn(m.token, config, 2000, from, len);
      if (!Number.isFinite(one)) continue;
      let sum = 0;
      for (let a = from; a < from + len; a += CADENCE) sum += env.grossOn(m.token, config, 2000, a, CADENCE);
      probes.push({ token: m.token, config, one, sum, absDiff: Math.abs(one - sum), relDiff: one === 0 ? 0 : Math.abs(one - sum) / Math.abs(one) });
    }
  }
  const worst = probes.reduce((a, b) => (b.relDiff > a.relDiff ? b : a), probes[0]);
  return { probes: probes.length, worstAbs: Math.max(...probes.map((p) => p.absDiff)), worstRel: worst ? worst.relDiff : NaN, worstToken: worst ? `${worst.token}/${worst.config}` : "н-д" };
}

const add = additivity();
console.log(`# Развёртка по числу позиций kmax\n`);
console.log(`Вселенная ${env.markets.length} рынков, год ${YEAR} ч, горизонт ${H} ч.`);
console.log(`Капитал $${CAPITAL}, каданс ${CADENCE} ч, ${STARTS} стартов со сдвигом ${STEP} ч, режим длины equal (${EQUAL_LEN} ч у каждого).\n`);
console.log(`АДДИТИВНОСТЬ НАЧИСЛЕНИЯ: ${add.probes} проб, худшее расхождение "один длинный отрезок против суммы отрезков по ${CADENCE} ч" $${add.worstAbs.toExponential(3)} (${(add.worstRel * 100).toExponential(3)}%, ${add.worstToken}).\n`);

const KS = KS_ARG ? KS_ARG.split(",").map((x) => (x.trim() === "inf" ? Infinity : Number(x))) : [1, 2, 3, 5, 8, Infinity];
const MODES = ["hold-pf", "rule-pf"];

const setsOf = (r) => r.log.filter((e) => e.act === "set");
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

const table = [];
const rawByKey = {};

for (const mode of MODES) {
  for (const kmax of KS) {
    const t0 = Date.now();
    const rs = [];
    for (let s = 0; s < STARTS; s += 1) {
      const first = H + s * STEP;
      rs.push(walk({ scan, env, capital: CAPITAL, cadence: CADENCE, kmax, mode, first, last: first + EQUAL_LEN }));
    }
    const nets = rs.map((r) => r.net);
    const gross = rs.map((r) => r.realized);
    const cost = rs.map((r) => r.costs);
    // Число позиций и задействованный капитал берутся по ВСЕМ событиям размещения, слитым по
    // стартам: медиана по стартам от медианы внутри старта прятала бы разброс дважды.
    const allSets = rs.flatMap(setsOf);
    const nPos = allSets.map((e) => e.n);
    const usd = allSets.map((e) => e.usd);
    const row = {
      mode,
      kmax: Number.isFinite(kmax) ? kmax : null,
      median: q(nets, 0.5),
      mean: mean(nets),
      min: Math.min(...nets),
      max: Math.max(...nets),
      p10: q(nets, 0.1),
      p90: q(nets, 0.9),
      medianGross: q(gross, 0.5),
      medianCosts: q(cost, 0.5),
      medianPositions: nPos.length ? q(nPos, 0.5) : 0,
      maxPositions: nPos.length ? Math.max(...nPos) : 0,
      medianDeployedUsd: usd.length ? q(usd, 0.5) : 0,
      medianOpens: q(rs.map((r) => r.tally.open), 0.5),
      medianRebalances: q(rs.map((r) => r.tally.rebalances), 0.5),
      decisions: rs[0].decisions,
      nets,
      secs: (Date.now() - t0) / 1000,
    };
    table.push(row);
    rawByKey[`${mode}/${row.kmax ?? "inf"}`] = row;
    console.error(`${mode} k=${row.kmax ?? "inf"}  медиана $${row.median.toFixed(2)}  среднее $${row.mean.toFixed(2)}  позиций ${row.medianPositions.toFixed(1)}  ${row.secs.toFixed(1)}s`);
  }
}

console.log(`| рука | kmax | медиана нетто | среднее | мин | макс | p10 | p90 | брутто | издержки | позиций (мед) | задействовано | открытий | перекладок |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
for (const r of table) {
  console.log(`| ${r.mode} | ${r.kmax ?? "без предела"} | $${r.median.toFixed(2)} | $${r.mean.toFixed(2)} | $${r.min.toFixed(2)} | $${r.max.toFixed(2)} | $${r.p10.toFixed(2)} | $${r.p90.toFixed(2)} | $${r.medianGross.toFixed(2)} | $${r.medianCosts.toFixed(2)} | ${r.medianPositions.toFixed(1)} | $${r.medianDeployedUsd.toFixed(0)} | ${r.medianOpens.toFixed(0)} | ${r.medianRebalances.toFixed(0)} |`);
}

// ── МОНОТОННОСТЬ. Считается по МЕДИАНЕ и по СРЕДНЕМУ отдельно: если знак вывода зависит от того,
// какую из двух брать, это надо увидеть, а не выбрать удобную.
console.log(`\n## Монотонность\n`);
for (const mode of MODES) {
  const rows = table.filter((r) => r.mode === mode);
  for (const stat of ["median", "mean"]) {
    const v = rows.map((r) => r[stat]);
    const best = v.indexOf(Math.max(...v));
    const nonDecr = v.every((x, i) => i === 0 || x >= v[i - 1] - 1e-9);
    console.log(`${mode} по ${stat}: ${v.map((x, i) => `k=${rows[i].kmax ?? "inf"}:$${x.toFixed(2)}`).join("  ")}`);
    console.log(`   максимум при k=${rows[best].kmax ?? "без предела"}, неубывание по k: ${nonDecr ? "ДА" : "НЕТ"}`);
  }
}

// ── ПОСТАРТОВОЕ СРАВНЕНИЕ. Медиана по 12 стартам может двигаться от одного старта, поэтому
// отдельно считается, В СКОЛЬКИХ стартах k побеждает предыдущее k. Пары ОДНОГО старта.
console.log(`\n## Парное сравнение по стартам (сколько из ${STARTS} стартов k лучше соседа слева)\n`);
for (const mode of MODES) {
  const rows = table.filter((r) => r.mode === mode);
  for (let i = 1; i < rows.length; i += 1) {
    const wins = rows[i].nets.filter((x, j) => x > rows[i - 1].nets[j] + 1e-9).length;
    const d = rows[i].nets.map((x, j) => x - rows[i - 1].nets[j]);
    console.log(`${mode} k=${rows[i].kmax ?? "inf"} против k=${rows[i - 1].kmax ?? "inf"}: побед ${wins}/${STARTS}, медиана разницы $${q(d, 0.5).toFixed(2)}, среднее $${mean(d).toFixed(2)}`);
  }
  const rInf = rows[rows.length - 1];
  const r1 = rows[0];
  const wins = rInf.nets.filter((x, j) => x > r1.nets[j] + 1e-9).length;
  console.log(`${mode} k=inf против k=1: побед ${wins}/${STARTS}, медиана разницы $${q(rInf.nets.map((x, j) => x - r1.nets[j]), 0.5).toFixed(2)}`);
}

// ── СКОЛЬКО ПОЗИЦИЙ РАСПРЕДЕЛИТЕЛЬ БЕРЁТ САМ. Только k = без предела.
console.log(`\n## Сколько позиций распределитель выбирает САМ (kmax без предела)\n`);
const self = {};
for (const mode of MODES) {
  const rs = [];
  for (let s = 0; s < STARTS; s += 1) {
    const first = H + s * STEP;
    rs.push(walk({ scan, env, capital: CAPITAL, cadence: CADENCE, kmax: Infinity, mode, first, last: first + EQUAL_LEN }));
  }
  const allSets = rs.flatMap(setsOf);
  const n = allSets.map((e) => e.n);
  const usd = allSets.map((e) => e.usd);
  const hist = new Map();
  for (const x of n) hist.set(x, (hist.get(x) || 0) + 1);
  self[mode] = {
    events: n.length,
    median: q(n, 0.5),
    mean: mean(n),
    min: Math.min(...n),
    max: Math.max(...n),
    p10: q(n, 0.1),
    p90: q(n, 0.9),
    medianDeployedUsd: q(usd, 0.5),
    hist: [...hist].sort((a, b) => a[0] - b[0]),
  };
  console.log(`${mode}: событий размещения ${n.length}, медиана ${q(n, 0.5).toFixed(1)}, среднее ${mean(n).toFixed(2)}, размах ${Math.min(...n)}..${Math.max(...n)}, p10 ${q(n, 0.1).toFixed(1)}, p90 ${q(n, 0.9).toFixed(1)}, задействовано (мед) $${q(usd, 0.5).toFixed(0)} из $${CAPITAL}`);
  console.log(`   распределение: ${[...hist].sort((a, b) => a[0] - b[0]).map(([k, c]) => `${k}:${c}`).join(" ")}`);
}

if (OUT) {
  const fs = await import("node:fs");
  fs.writeFileSync(OUT, JSON.stringify({ capital: CAPITAL, cadence: CADENCE, starts: STARTS, step: STEP, equalLen: EQUAL_LEN, year: YEAR, markets: env.markets.length, additivity: add, table, self }, null, 2));
  console.error(`записано ${OUT}`);
}
