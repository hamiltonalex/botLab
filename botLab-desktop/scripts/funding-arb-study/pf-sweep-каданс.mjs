// pf-sweep-каданс.mjs - РАЗВЁРТКА КАДАНСА ДЛЯ ПОРТФЕЛЯ ПРОТИВ ОДНОЙ ПОЗИЦИИ. READ-ONLY.
//
// ВОПРОС. У ОДНОЙ позиции замер правила выхода дал 24 ч лучшим разменом между свежестью решения и
// платой за перекладки. Портфель платит за перекладку иначе: круг платят только те позиции, у
// которых изменились токен, конфигурация или размер, а размер у портфеля меняется на КАЖДОМ
// переразмещении, потому что распределитель двигает границу по всем плечам сразу. Значит цена
// частоты у портфеля выше, и точка размена может уехать. Проверяется это только счётом.
//
// ЧТО ЗДЕСЬ НЕ РЕШАЕТСЯ. Ходок не трогается: решения принимает pf-walk.mjs, здесь только развёртка
// параметра и сводка. Вторая реализация критерия под ту же задачу означала бы, что развёртка
// доказывает саму себя.
//
// ДЛИНА ПРОГОНА ОДИНАКОВА У ВСЕХ СТАРТОВ (режим "equal"). Иначе поздние старты короче ранних и
// разброс руки на 8% состоит из длины окна, а не из поведения.
//
// ПРОВЕРКА НАЧИСЛЕНИЯ. Развёртка каданса меняет РАЗБИВКУ начисления на отрезки. Если сумма
// отрезков не равна одному длинному начислению, сравнение кадансов мерило бы разбивку, а не
// правило. Поэтому перед сводкой стоит прямая проверка аддитивности, и её число печатается.

import fs from "node:fs";
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { q, $, H } from "./pf-lib.mjs";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const SCAN = argOf("--scan");
const CAPITAL = Number(argOf("--capital", 5000));
const STARTS = Number(argOf("--starts", 12));
const STEP = Number(argOf("--step", 60));
const CADENCES = String(argOf("--cadences", "1,24,168,720")).split(",").map(Number);
const OUT = argOf("--out", null);
if (!SCAN) { console.error("--scan обязателен"); process.exit(1); }

const scan = loadScan(SCAN);
const env = makeEnv();
const YEAR = env.YEAR;
const LAST_FIRST = H + (STARTS - 1) * STEP;
const EQUAL_LEN = YEAR - LAST_FIRST;

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// ── ПРОВЕРКА АДДИТИВНОСТИ НАЧИСЛЕНИЯ. Сумма отрезков длины cad против одного отрезка целиком, на
// том же рынке, той же ноге и том же размере. Берутся все рынки вселенной, а не образец.
function additivity(cadences) {
  const from = 1000;
  const len = 2400;
  const rows = [];
  for (const cad of cadences) {
    let maxAbs = 0;
    let maxRel = 0;
    for (const m of env.markets) {
      for (const config of ["A", "B"]) {
        for (const S of [500, 1594.37, 5000]) {
          const one = env.grossOn(m.token, config, S, from, len);
          if (!Number.isFinite(one)) continue;
          let sum = 0;
          let ok = true;
          for (let a = from; a < from + len; a += cad) {
            const g = env.grossOn(m.token, config, S, a, Math.min(cad, from + len - a));
            if (!Number.isFinite(g)) { ok = false; break; }
            sum += g;
          }
          if (!ok) continue;
          const abs = Math.abs(sum - one);
          const rel = Math.abs(one) > 1e-9 ? abs / Math.abs(one) : 0;
          if (abs > maxAbs) maxAbs = abs;
          if (rel > maxRel) maxRel = rel;
        }
      }
    }
    rows.push({ cadence: cad, maxAbsUsd: maxAbs, maxRel });
  }
  return rows;
}

const setsOf = (r) => r.log.filter((e) => e.act === "set");
const posOf = (r) => { const s = setsOf(r); return s.length ? q(s.map((e) => e.n), 0.5) : 0; };
const usdOf = (r) => { const s = setsOf(r); return s.length ? q(s.map((e) => e.usd), 0.5) : 0; };

function series(mode, cadence) {
  const out = [];
  for (let s = 0; s < STARTS; s += 1) {
    const first = H + s * STEP;
    out.push(walk({ scan, env, capital: CAPITAL, cadence, kmax: Infinity, mode, first, last: first + EQUAL_LEN }));
  }
  return out;
}

function summarize(mode, cadence, rs) {
  const nets = rs.map((r) => r.net);
  return {
    mode,
    cadence,
    starts: rs.length,
    decisions: rs[0].decisions,
    netMedian: q(nets, 0.5),
    netMean: mean(nets),
    netMin: Math.min(...nets),
    netMax: Math.max(...nets),
    netP10: q(nets, 0.1),
    netP90: q(nets, 0.9),
    tripsMedian: q(rs.map((r) => r.tally.open), 0.5),
    tripsMean: mean(rs.map((r) => r.tally.open)),
    tripsMin: Math.min(...rs.map((r) => r.tally.open)),
    tripsMax: Math.max(...rs.map((r) => r.tally.open)),
    costsMedianUsd: q(rs.map((r) => r.costs), 0.5),
    grossMedianUsd: q(rs.map((r) => r.realized), 0.5),
    rebalancesMedian: q(rs.map((r) => r.tally.rebalances), 0.5),
    cashMedian: q(rs.map((r) => r.tally.cash), 0.5),
    posMedian: q(rs.map(posOf), 0.5),
    usdMedian: q(rs.map(usdOf), 0.5),
    nets,
    trips: rs.map((r) => r.tally.open),
  };
}

console.log(`# Развёртка каданса: портфель против одной позиции\n`);
console.log(`Вселенная ${env.markets.length} рынков, год ${YEAR} ч, горизонт ${H} ч, капитал $${CAPITAL},`);
console.log(`${STARTS} стартов со сдвигом ${STEP} ч, режим длины "equal": все старты идут по ${EQUAL_LEN} ч.`);
console.log(`Кадансы: ${CADENCES.join(", ")} ч.\n`);

const add = additivity(CADENCES);
console.log(`## Проверка аддитивности начисления\n`);
console.log(`Сумма отрезков длины каданса против одного начисления за 2400 ч, все ${env.markets.length} рынков, обе ноги, три размера.\n`);
console.log(`| каданс | макс. расхождение | макс. относительное |`);
console.log(`|---|---|---|`);
for (const a of add) console.log(`| ${a.cadence} | ${a.maxAbsUsd.toExponential(2)} | ${a.maxRel.toExponential(2)} |`);

const table = [];
const paired = [];
for (const cadence of CADENCES) {
  const byMode = {};
  for (const mode of ["rule-1", "rule-pf"]) {
    const rs = series(mode, cadence);
    byMode[mode] = summarize(mode, cadence, rs);
    table.push(byMode[mode]);
    console.error(`готово ${mode} каданс ${cadence}`);
  }
  const d = byMode["rule-pf"].nets.map((x, i) => x - byMode["rule-1"].nets[i]);
  paired.push({
    cadence,
    pfWins: d.filter((x) => x > 0).length,
    n: d.length,
    diffMedian: q(d, 0.5),
    diffMean: mean(d),
    diffMin: Math.min(...d),
    diffMax: Math.max(...d),
    extraTripsMedian: byMode["rule-pf"].tripsMedian - byMode["rule-1"].tripsMedian,
  });
}

// Опора без правила. Каданс на них не влияет по построению (вошли один раз и держим), и это
// печатается как контроль: если бы влиял, стенд протекал бы.
const base = [];
for (const mode of ["hold-1", "hold-pf"]) {
  for (const cadence of CADENCES) {
    const rs = series(mode, cadence);
    base.push(summarize(mode, cadence, rs));
    console.error(`готово ${mode} каданс ${cadence}`);
  }
}

const row = (s) => `| ${s.mode} | ${s.cadence} | ${$(s.netMedian)} | ${$(s.netMean)} | ${$(s.netMin)} | ${$(s.netMax)} | ${s.tripsMedian.toFixed(0)} | ${$(s.costsMedianUsd)} | ${s.posMedian.toFixed(1)} | ${$(s.usdMedian)} | ${s.decisions} |`;

console.log(`\n## Правило: rule-1 против rule-pf по кадансам\n`);
console.log(`| рука | каданс | медиана нетто | среднее | мин | макс | кругов (медиана) | издержки | позиций | задействовано | решений |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);
for (const s of table) console.log(row(s));

console.log(`\n## Опора без правила (контроль: каданс на неё не влияет)\n`);
console.log(`| рука | каданс | медиана нетто | среднее | мин | макс | кругов (медиана) | издержки | позиций | задействовано | решений |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);
for (const s of base) console.log(row(s));

console.log(`\n## Парно по стартам: rule-pf минус rule-1\n`);
console.log(`| каданс | pf выигрывает | медиана разности | среднее | мин | макс | лишних кругов |`);
console.log(`|---|---|---|---|---|---|---|`);
for (const p of paired) console.log(`| ${p.cadence} | ${p.pfWins} из ${p.n} | ${$(p.diffMedian)} | ${$(p.diffMean)} | ${$(p.diffMin)} | ${$(p.diffMax)} | ${p.extraTripsMedian.toFixed(0)} |`);

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({
    capital: CAPITAL, starts: STARTS, step: STEP, equalLen: EQUAL_LEN, year: YEAR, horizon: H,
    cadences: CADENCES, additivity: add, rule: table, base, paired,
  }, null, 2));
  console.error(`-> ${OUT}`);
}
