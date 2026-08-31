// pf-sweep-состав.mjs - СОСТАВ ПОРТФЕЛЯ ПРОТИВ СОСТАВА ОДНОЙ ПОЗИЦИИ. READ-ONLY.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ ОТДЕЛЬНО ОТ pf-1-run.mjs. Тот печатает нетто по четырём рукам, и по нему видно
// ЧТО вышло, но не видно ИЗ ЧЕГО. Здесь считается ровно состав: какие рынки берёт hold-pf на
// каждом из 12 стартов, повторяются ли они, и сколько РАЗЛИЧНЫХ первых рынков успевает поймать
// hold-1. Вопрос не косметический: если различных рынков у hold-1 два-три, его "мин-макс" это не
// 12 наблюдений, а два-три числа с кратностями, и подавать размах как распределение нельзя.
//
// ХОДОК НЕ ПЕРЕПИСАН. Всё считает walk() из pf-walk.mjs, здесь только запуск и разбор его лога:
// вторая реализация ходока означала бы, что состав меряется против собственной копии правил.
//
// НАЧИСЛЕНИЕ ПРОВЕРЯЕТСЯ ЗДЕСЬ ЖЕ. Ходок копит брутто отрезками между точками решения. Если сумма
// отрезков не равна одному длинному начислению за тот же период, число зависит от разбивки, и
// тогда сравнение рук с разным числом перекладок нечестно по построению. Проверка внизу файла.

import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { q, H } from "./pf-lib.mjs";

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
const EQUAL_LEN = YEAR - LAST_FIRST;

const MODES = ["hold-1", "hold-pf", "rule-1", "rule-pf"];
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "н-д");

function series(mode, lenMode) {
  const out = [];
  for (let s = 0; s < STARTS; s += 1) {
    const first = H + s * STEP;
    const last = lenMode === "equal" ? first + EQUAL_LEN : YEAR;
    out.push(walk({ scan, env, capital: CAPITAL, cadence: CADENCE, mode, first, last }));
  }
  return out;
}
const sets = (r) => r.log.filter((e) => e.act === "set");
const firstSet = (r) => sets(r)[0] || null;

console.log(`# Состав рук. Вселенная ${env.markets.length} рынков, год ${YEAR} ч, горизонт ${H} ч.`);
console.log(`# Капитал $${CAPITAL}, каданс ${CADENCE} ч, ${STARTS} стартов со сдвигом ${STEP} ч, equal-длина ${EQUAL_LEN} ч.\n`);

// ── 1. Нетто по рукам в обоих режимах длины. "theirs" только для сверки с числами фазы 3.
const bag = {};
for (const lenMode of ["theirs", "equal"]) {
  console.log(`## нетто, режим длины ${lenMode}`);
  console.log(`| рука | медиана | среднее | мин | макс | позиций(медиана) | задействовано(медиана) | кругов(медиана) |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  for (const mode of MODES) {
    const rs = series(mode, lenMode);
    bag[`${mode}|${lenMode}`] = rs;
    const nets = rs.map((r) => r.net);
    const npos = rs.map((r) => { const s = sets(r); return s.length ? q(s.map((e) => e.n), 0.5) : 0; });
    const usd = rs.map((r) => { const s = sets(r); return s.length ? q(s.map((e) => e.usd), 0.5) : 0; });
    console.log(`| ${mode} | ${f2(q(nets, 0.5))} | ${f2(nets.reduce((a, b) => a + b, 0) / nets.length)} | ${f2(Math.min(...nets))} | ${f2(Math.max(...nets))} | ${q(npos, 0.5).toFixed(1)} | ${f2(q(usd, 0.5))} | ${q(rs.map((r) => r.tally.open), 0.5).toFixed(0)} |`);
  }
  console.log("");
}

// ── 2. Состав hold-pf по стартам. Порядок токенов в подписи НОРМАЛИЗОВАН сортировкой: иначе два
// одинаковых по существу состава считались бы разными из-за порядка обхода.
for (const lenMode of ["equal", "theirs"]) {
  const rs = bag[`hold-pf|${lenMode}`];
  console.log(`## состав hold-pf по стартам, режим ${lenMode}`);
  console.log(`| старт(час) | k | капитал занят | нетто | состав |`);
  console.log(`|---|---|---|---|---|`);
  const perStart = [];
  for (let i = 0; i < rs.length; i += 1) {
    const r = rs[i], s = firstSet(r);
    const toks = s ? s.tokens.split("+").sort() : [];
    perStart.push(toks);
    console.log(`| ${r.first} | ${s ? s.n : 0} | ${s ? f2(s.usd) : "0"} | ${f2(r.net)} | ${toks.join(" ")} |`);
  }
  const uni = new Map();
  for (const toks of perStart) for (const t of toks) uni.set(t, (uni.get(t) || 0) + 1);
  const sigs = perStart.map((t) => t.join("+"));
  console.log(`\nРАЗЛИЧНЫХ рынков в объединении по ${STARTS} стартам: ${uni.size}`);
  console.log(`РАЗЛИЧНЫХ составов (как множеств): ${new Set(sigs).size} из ${STARTS}`);
  console.log(`во сколько стартов входит рынок:`);
  for (const [t, n] of [...uni].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) console.log(`   ${String(n).padStart(2)}/${STARTS}  ${t}`);
  console.log(`ядро (во ВСЕХ ${STARTS} стартах): ${[...uni].filter(([, n]) => n === STARTS).map(([t]) => t).join(" ") || "нет"}`);
  console.log(`разово (ровно в 1 старте): ${[...uni].filter(([, n]) => n === 1).map(([t]) => t).join(" ") || "нет"}`);
  console.log("");
}

// ── 3. hold-1: сколько РАЗЛИЧНЫХ первых рынков и с какими кратностями.
for (const lenMode of ["equal", "theirs"]) {
  const rs = bag[`hold-1|${lenMode}`];
  console.log(`## hold-1 по стартам, режим ${lenMode}`);
  console.log(`| старт(час) | рынок | размер | нетто |`);
  console.log(`|---|---|---|---|`);
  const cnt = new Map();
  for (const r of rs) {
    const s = firstSet(r);
    const tok = s ? s.tokens : "н-д";
    console.log(`| ${r.first} | ${tok} | ${s ? f2(s.usd) : "0"} | ${f2(r.net)} |`);
    if (!cnt.has(tok)) cnt.set(tok, []);
    cnt.get(tok).push(r.net);
  }
  console.log(`\nРАЗЛИЧНЫХ первых рынков: ${cnt.size} из ${STARTS}`);
  for (const [t, v] of [...cnt].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`   ${String(v.length).padStart(2)}x ${t.padEnd(8)} нетто ${f2(Math.min(...v))} .. ${f2(Math.max(...v))} (медиана ${f2(q(v, 0.5))})`);
  }
  const nets = rs.map((r) => r.net);
  console.log(`   размах мин-макс = ${f2(Math.max(...nets) - Math.min(...nets))}; РАЗЛИЧНЫХ значений нетто ${new Set(nets.map((x) => x.toFixed(6))).size}`);
  console.log("");
}

// ── 4. Тот же вопрос для рук с правилом: сколько разных рынков они вообще посещают.
for (const mode of ["rule-1", "rule-pf"]) {
  const rs = bag[`${mode}|equal`];
  const uni = new Set();
  let setsTotal = 0;
  for (const r of rs) for (const e of sets(r)) { setsTotal += 1; for (const t of e.tokens.split("+")) uni.add(t); }
  console.log(`${mode} (equal): различных рынков за все старты ${uni.size}, размещений ${setsTotal}, первых рынков различных ${new Set(rs.map((r) => (firstSet(r) || {}).tokens || "н-д")).size}`);
}
console.log("");

// ── 5. АДДИТИВНОСТЬ НАЧИСЛЕНИЯ. Одно длинное начисление против суммы отрезков по кадансу.
console.log(`## проверка аддитивности начисления (одно длинное против суммы отрезков)`);
const probes = [];
const toks = env.markets.slice(0, 8).map((m) => m.token);
for (const token of toks) for (const config of ["A", "B"]) for (const sizeUsd of [1000, 5000]) probes.push({ token, config, sizeUsd });
let worstAbs = 0, worstRel = 0, worstDesc = "";
let n = 0;
for (const p of probes) {
  const from = 720, len = 2400;
  const one = env.grossOn(p.token, p.config, p.sizeUsd, from, len);
  if (!Number.isFinite(one)) continue;
  let sum = 0, bad = false;
  for (let o = 0; o < len; o += CADENCE) {
    const g = env.grossOn(p.token, p.config, p.sizeUsd, from + o, Math.min(CADENCE, len - o));
    if (!Number.isFinite(g)) { bad = true; break; }
    sum += g;
  }
  if (bad) continue;
  n += 1;
  const abs = Math.abs(sum - one);
  const rel = Math.abs(one) > 0 ? abs / Math.abs(one) : 0;
  if (abs > worstAbs) { worstAbs = abs; worstDesc = `${p.token}/${p.config}/$${p.sizeUsd}: одно ${one.toFixed(9)} против суммы ${sum.toFixed(9)}`; }
  if (rel > worstRel) worstRel = rel;
}
console.log(`проб ${n}, худшее абсолютное расхождение ${worstAbs.toExponential(3)} USD, худшее относительное ${worstRel.toExponential(3)}`);
console.log(`худшая проба: ${worstDesc}`);
