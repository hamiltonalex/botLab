// pf-sweep-капитал.mjs - РАЗВЁРТКА ПО КАПИТАЛУ ДЛЯ ДВУХ ДЕРЖАЩИХ РУК. READ-ONLY.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ. Потолок ёмкости ОДНОЙ позиции был назван около $1786 в год при капитале
// $25k: дальше разбавление съедало прибавку. Вопрос: двигает ли этот потолок портфель и насколько.
// Ходок НЕ переписывается, он взят из pf-walk.mjs как есть; здесь только развёртка и свод.
//
// ОБЯЗАТЕЛЬНАЯ ОГОВОРКА, КОТОРУЮ НЕЛЬЗЯ ПОТЕРЯТЬ В ТАБЛИЦЕ. Потолок ТИКЕТА $5000
// (FA_SIZING_DEFAULTS.ticketCapUsd) физически не даёт ОДНОЙ позиции взять больше $5000, поэтому на
// капиталах выше $5000 рука hold-1 не может освоить деньги ВООБЩЕ. Разрыв рук на $10k и выше это в
// первую очередь простаивающий капитал, а не превосходство размещения. Столбец «задействовано»
// ставится рядом с нетто именно для того, чтобы это было видно, а не подразумевалось.
//
// НАЧИСЛЕНИЕ ОТРЕЗКАМИ. Ходок копит брутто кусками между точками решения. Если сумма кусков не
// равна одному длинному начислению за тот же период, число зависит от разбивки, и тогда вся
// развёртка меряет каданс, а не капитал. Поэтому проверка идёт ПЕРВОЙ и её итог печатается.

import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { q, $, H } from "./pf-lib.mjs";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const SCAN = argOf("--scan");
const CADENCE = Number(argOf("--cadence", 24));
const STARTS = Number(argOf("--starts", 12));
const STEP = Number(argOf("--step", 60));
const CAPITALS = (argOf("--capitals", "1000,2000,5000,10000,25000,50000,100000")).split(",").map(Number);

const t0 = Date.now();
const scan = loadScan(SCAN);
const env = makeEnv();
const YEAR = env.YEAR;
const LAST_FIRST = H + (STARTS - 1) * STEP;
const EQUAL_LEN = YEAR - LAST_FIRST;

console.log(`# Развёртка по капиталу: hold-1 против hold-pf, режим длины equal\n`);
console.log(`Вселенная ${env.markets.length} рынков, год ${YEAR} ч, горизонт ${H} ч, каданс ${CADENCE} ч,`);
console.log(`${STARTS} стартов со сдвигом ${STEP} ч, у всех одинаковая длина ${EQUAL_LEN} ч (${(EQUAL_LEN / 24).toFixed(1)} сут).\n`);

// ── ПРОВЕРКА АДДИТИВНОСТИ НАЧИСЛЕНИЯ. Берём реальные рынки из снимка первого часа решения и
// сверяем одно длинное начисление с суммой кусков по кадансу.
{
  const t = H;
  const ok = (scan.get(t) || []).slice(0, 6);
  console.log(`## Проверка: сумма отрезков против одного длинного начисления\n`);
  console.log(`| рынок | размер | одно начисление за ${EQUAL_LEN} ч | сумма кусков по ${CADENCE} ч | расхождение |`);
  console.log(`|---|---|---|---|---|`);
  let worst = 0;
  for (const c of ok) {
    const one = env.grossOn(c.k, c.c, c.s, t, EQUAL_LEN);
    let sum = 0;
    for (let u = t; u < t + EQUAL_LEN; u += CADENCE) {
      const len = Math.min(CADENCE, t + EQUAL_LEN - u);
      const g = env.grossOn(c.k, c.c, c.s, u, len);
      if (Number.isFinite(g)) sum += g;
    }
    const d = sum - one;
    const rel = Math.abs(one) > 0 ? Math.abs(d / one) : NaN;
    if (Number.isFinite(rel)) worst = Math.max(worst, rel);
    console.log(`| ${c.k} | $${c.s.toFixed(0)} | ${$(one)} | ${$(sum)} | ${d.toExponential(3)} (${(rel * 100).toFixed(6)}%) |`);
  }
  console.log(`\nХУДШЕЕ ОТНОСИТЕЛЬНОЕ РАСХОЖДЕНИЕ: ${(worst * 100).toExponential(3)} %\n`);
}

const setsOf = (r) => r.log.filter((e) => e.act === "set");
const firstSet = (r) => setsOf(r)[0] || null;

function series(mode, capital) {
  const out = [];
  for (let s = 0; s < STARTS; s += 1) {
    const first = H + s * STEP;
    out.push(walk({ scan, env, capital, cadence: CADENCE, mode, first, last: first + EQUAL_LEN }));
  }
  return out;
}

const rows = [];
for (const capital of CAPITALS) {
  const rec = { capital };
  for (const mode of ["hold-1", "hold-pf"]) {
    const rs = series(mode, capital);
    const nets = rs.map((r) => r.net);
    const gross = rs.map((r) => r.realized);
    const cost = rs.map((r) => r.costs);
    const used = rs.map((r) => (firstSet(r) ? firstSet(r).usd : 0));
    const npos = rs.map((r) => (firstSet(r) ? firstSet(r).n : 0));
    const toks = rs.map((r) => (firstSet(r) ? firstSet(r).tokens : "н-д"));
    rec[mode] = {
      nets, med: q(nets, 0.5), mean: nets.reduce((a, b) => a + b, 0) / nets.length,
      min: Math.min(...nets), max: Math.max(...nets), p10: q(nets, 0.1), p90: q(nets, 0.9),
      medGross: q(gross, 0.5), medCost: q(cost, 0.5),
      medUsed: q(used, 0.5), medPos: q(npos, 0.5), minPos: Math.min(...npos), maxPos: Math.max(...npos),
      uniqFirst: new Set(toks).size, decisions: rs[0].decisions,
    };
  }
  rows.push(rec);
  console.error(`… капитал $${capital} готов, ${((Date.now() - t0) / 1000).toFixed(0)} с`);
}

console.log(`## Свод: медиана нетто за ${(EQUAL_LEN / 24 / 365 * 12).toFixed(1)} мес по 12 стартам\n`);
console.log(`| капитал | hold-1 нетто | освоено | hold-1 годовых | hold-pf нетто | освоено | позиций | hold-pf годовых | прибавка $ | прибавка × |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|`);
const yr = (x) => (x / EQUAL_LEN) * 8760;
for (const r of rows) {
  const a = r["hold-1"], b = r["hold-pf"];
  console.log(`| $${r.capital} | ${$(a.med)} | ${$(a.medUsed)} | ${(yr(a.med) / r.capital * 100).toFixed(2)}% | ${$(b.med)} | ${$(b.medUsed)} | ${b.medPos.toFixed(0)} | ${(yr(b.med) / r.capital * 100).toFixed(2)}% | ${$(b.med - a.med)} | ${(b.med / a.med).toFixed(2)}x |`);
}

console.log(`\n## То же в ГОДОВОМ выражении (нетто * 8760 / ${EQUAL_LEN}), чтобы сравнивать с $1786\n`);
console.log(`| капитал | hold-1 год | hold-pf год | hold-1 освоено | hold-pf освоено | простаивает у hold-1 |`);
console.log(`|---|---|---|---|---|---|`);
for (const r of rows) {
  const a = r["hold-1"], b = r["hold-pf"];
  console.log(`| $${r.capital} | ${$(yr(a.med))} | ${$(yr(b.med))} | ${$(a.medUsed)} | ${$(b.medUsed)} | ${$(r.capital - a.medUsed)} (${((1 - a.medUsed / r.capital) * 100).toFixed(0)}%) |`);
}

console.log(`\n## Разброс по стартам\n`);
console.log(`| капитал | рука | медиана | среднее | мин | p10 | p90 | макс | различных первых составов | решений |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|`);
for (const r of rows) {
  for (const mode of ["hold-1", "hold-pf"]) {
    const x = r[mode];
    console.log(`| $${r.capital} | ${mode} | ${$(x.med)} | ${$(x.mean)} | ${$(x.min)} | ${$(x.p10)} | ${$(x.p90)} | ${$(x.max)} | ${x.uniqFirst} | ${x.decisions} |`);
  }
}

console.log(`\n## Брутто и издержки (медианы), чтобы видно было, что кругов у держащих рук один набор\n`);
console.log(`| капитал | рука | брутто | издержки | нетто | позиций мин..макс |`);
console.log(`|---|---|---|---|---|---|`);
for (const r of rows) {
  for (const mode of ["hold-1", "hold-pf"]) {
    const x = r[mode];
    console.log(`| $${r.capital} | ${mode} | ${$(x.medGross)} | ${$(x.medCost)} | ${$(x.med)} | ${x.minPos}..${x.maxPos} |`);
  }
}

console.log(`\nВсе 12 значений нетто по стартам (для воспроизводимости):\n`);
for (const r of rows) {
  for (const mode of ["hold-1", "hold-pf"]) {
    console.log(`$${r.capital} ${mode}: ${r[mode].nets.map((v) => v.toFixed(2)).join(", ")}`);
  }
}
console.log(`\nготово за ${((Date.now() - t0) / 1000).toFixed(0)} с`);

// ── СОСТАВ ПЕРВОГО РАЗМЕЩЕНИЯ. При малом капитале hold-pf берёт ОДНУ позицию, как и hold-1, но
// нетто у них разное: значит жадный проход по наклону выбирает ДРУГОЙ рынок, чем «лучший по n».
// Без этого столбца разница на $1000 выглядела бы как цена дробления, а дробления там нет.
console.log(`\n## Состав первого размещения по капиталам (старт h=720)\n`);
for (const capital of CAPITALS) {
  for (const mode of ["hold-1", "hold-pf"]) {
    const r = walk({ scan, env, capital, cadence: CADENCE, mode, first: H, last: H + EQUAL_LEN });
    const s = firstSet(r);
    console.log(`$${String(capital).padStart(6)} ${mode.padEnd(8)} n=${String(s ? s.n : 0).padStart(2)} освоено $${(s ? s.usd : 0).toFixed(0).padStart(6)} нетто $${r.net.toFixed(2).padStart(9)}  ${s ? s.tokens : "н-д"}`);
  }
}

// ── ТОЧНЫЕ ЧИСЛА. Форматирование $ округляет до 0.1k выше тысячи, и по таблице выше нельзя
// восстановить величину. Машинный блок ниже - единственный источник для отчёта.
console.log(`\n<<<JSON`);
console.log(JSON.stringify({
  year: YEAR, horizonH: H, equalLen: EQUAL_LEN, starts: STARTS, step: STEP, cadence: CADENCE,
  markets: env.markets.length,
  rows: rows.map((r) => ({
    capital: r.capital,
    "hold-1": { med: r["hold-1"].med, mean: r["hold-1"].mean, min: r["hold-1"].min, max: r["hold-1"].max, medUsed: r["hold-1"].medUsed, medPos: r["hold-1"].medPos, medGross: r["hold-1"].medGross, medCost: r["hold-1"].medCost, nets: r["hold-1"].nets },
    "hold-pf": { med: r["hold-pf"].med, mean: r["hold-pf"].mean, min: r["hold-pf"].min, max: r["hold-pf"].max, medUsed: r["hold-pf"].medUsed, medPos: r["hold-pf"].medPos, medGross: r["hold-pf"].medGross, medCost: r["hold-pf"].medCost, nets: r["hold-pf"].nets },
  })),
}, null, 1));
console.log(`JSON>>>`);
