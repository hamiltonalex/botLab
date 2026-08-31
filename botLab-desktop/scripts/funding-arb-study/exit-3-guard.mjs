// exit-3-guard.mjs - ЗАМЕР З3: УСПЕВАЕТ ЛИ ТРЕЙЛИНГ-ОЦЕНКА И НУЖНА ЛИ БЫСТРАЯ ОХРАНА. READ-ONLY.
//
// ПЕРВАЯ ВЕРСИЯ ЭТОГО ЗАМЕРА БЫЛА НЕВЕРНА, И ОШИБКА СТОИТ ТОГО, ЧТОБЫ ЕЁ ЗАПИСАТЬ. Она подставляла
// в данные «обвал базы» и смотрела, через сколько часов трейлинг заметит убыток. Убытка не
// возникало вовсе: брутто РОСЛО. Причина арифметическая, проверена численно:
//
//   доход за секунду = f * B/(B+S) * S,  а при сохранённом потоке рынка f = pot/B,
//   значит  доход = pot * S/(B+S),  и это выражение УБЫВАЕТ по B.
//
// Таблица при pot = $0.001/с и S = $5000: база $10M даёт удержание 99.95% и доход 5.0e-7; база $100
// даёт удержание 1.96% и доход 9.8e-4, то есть в 2000 раз БОЛЬШЕ. Малая база нашей стороны означает,
// что мы забираем большую долю потока, а не что нас обделили.
//
// СЛЕДСТВИЕ, РАДИ КОТОРОГО ЗАМЕР И ДЕЛАЛСЯ: НИЗКОЕ УДЕРЖАНИЕ НЕ ЕСТЬ ПРИЗНАК УБЫТОЧНОСТИ. Оно
// говорит, что КОТИРУЕМАЯ ставка вводит в заблуждение, и потому карточка честности в интерфейсе
// нужна. Но охрана вида «удержание упало ниже 0.5, закрываемся» (`safetyDilutionFloor` в плане
// автомата) закрывала бы позиции, которые зарабатывают БОЛЬШЕ всего. Такой охраны здесь не будет.
//
// ОГРАНИЧЕНИЕ О2 ЭТИМ НЕ ЗАДЕТО, и путать эти два утверждения нельзя. О2 решает другую задачу: там
// S это ВЫБИРАЕМАЯ величина при данной B, доход по S насыщается на `pot`, а издержки растут линейно,
// поэтому потолок нужен. Здесь B меняется при уже выбранном S, и знак зависимости обратный.
//
// ЧТО МЕРЯЕТСЯ ВМЕСТО ЭТОГО. Настоящий вопрос владельца звучит «выходит ЗАБЛАГОВРЕМЕННО», то есть
// про УПРЕЖДЕНИЕ. Значит мерить надо не выдуманный обвал, а согласие трейлинг-оценки с тем, что
// произошло НА САМОМ ДЕЛЕ. Подстановок в данные тут нет вовсе:
//   трейлинг(t) = брутто на окне [t-H, t), это то, что правило ВИДИТ в час t;
//   вперёд(t)   = брутто на окне [t, t+H),  это то, что случится, если держать.
// Дальше три числа: доля часов, где правило вышло бы и было право; доля убыточных часов, которые
// правило поймало; и упреждение, то есть за сколько часов до того, как «вперёд» уходит в минус,
// трейлинг успевает сменить знак.

import { loadUniverse, loadCapacity, H, q, $, iso } from "./exit-lib.mjs";
import { netAtSize } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";
import { scanTwoLeg } from "../../src/engine/math.js";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const SIZE = Number(argOf("--size", 5000)); // потолок тикета: размер, которым правило входа и торгует
const STRIDE = Number(argOf("--stride", 6));

const { markets } = loadUniverse();
const { impactFor } = loadCapacity();

console.log(`# З3: успевает ли трейлинг-оценка и нужна ли быстрая охрана\n`);
console.log(`Вселенная ${markets.length} рынков, горизонт ${H} ч, размер $${SIZE} (потолок тикета), шаг ${STRIDE} ч.`);
console.log(`Подстановок в данные НЕТ: сравниваются окно назад и окно вперёд по одним и тем же строкам.\n`);

const rows0 = markets[0].rows.length;
let nHours = 0;
let agree = 0;
let trailNegForwardNeg = 0;
let trailNeg = 0;
let forwardNeg = 0;
const leads = [];
const perMarket = [];

for (const m of markets) {
  const grossOn = (from, config) => {
    const seg = m.rows.slice(from, from + H);
    if (seg.length !== H) return NaN;
    const r = netAtSize({ rows: seg, config, strategy: "two", sizeUsd: SIZE, costs: DEFAULT_COSTS, impact: impactFor(m.token, config === "A" ? "short" : "long") });
    return r ? r.gross : NaN;
  };
  const pts = [];
  for (let t = H; t + H <= m.rows.length; t += STRIDE) {
    // Конфигурацию ноги выбирает `scanTwoLeg` по трейлингу, как это делает правило входа. Повторять
    // выбор здесь значило бы завести вторую его реализацию.
    const config = scanTwoLeg(m.rows.slice(t - H, t), { token: m.token })?.chosen;
    if (!config) continue;
    const back = grossOn(t - H, config);
    const fwd = grossOn(t, config);
    if (!Number.isFinite(back) || !Number.isFinite(fwd)) continue;
    pts.push({ t, back, fwd });
  }
  if (!pts.length) continue;
  let a = 0;
  let tn = 0;
  let fn = 0;
  let both = 0;
  for (const p of pts) {
    nHours += 1;
    if ((p.back < 0) === (p.fwd < 0)) { agree += 1; a += 1; }
    if (p.back < 0) { trailNeg += 1; tn += 1; }
    if (p.fwd < 0) { forwardNeg += 1; fn += 1; }
    if (p.back < 0 && p.fwd < 0) { trailNegForwardNeg += 1; both += 1; }
  }
  // УПРЕЖДЕНИЕ. Эпизод это переход «вперёд» из плюса в минус. Ищем ближайший предшествующий момент,
  // где трейлинг уже отрицателен и остаётся таким до эпизода: положительное число значит, что
  // правило вышло РАНЬШЕ убытка, отрицательное - что опоздало.
  for (let i = 1; i < pts.length; i += 1) {
    if (!(pts[i - 1].fwd >= 0 && pts[i].fwd < 0)) continue;
    let lead = null;
    for (let j = i; j >= 0; j -= 1) { if (pts[j].back >= 0) { lead = (i - j - 1) * STRIDE; break; } }
    if (lead === null) lead = (i + 1) * STRIDE; // трейлинг был отрицателен на всём доступном ряду
    if (lead > 0) { leads.push(lead); continue; }
    let late = null;
    for (let j = i; j < pts.length; j += 1) { if (pts[j].back < 0) { late = -(j - i) * STRIDE; break; } }
    leads.push(late === null ? -Infinity : late);
  }
  perMarket.push({ token: m.token, n: pts.length, agree: a / pts.length, trailNeg: tn / pts.length, fwdNeg: fn / pts.length, both });
}

console.log(`## Согласие трейлинга с тем, что произошло на самом деле\n`);
console.log(`Точек решения ${nHours} (${markets.length} рынков по ${Math.round(nHours / markets.length)} на каждый).\n`);
console.log(`| величина | значение |`);
console.log(`|---|---|`);
console.log(`| знак совпал | ${((agree / nHours) * 100).toFixed(1)}% |`);
console.log(`| трейлинг отрицателен (правило вышло бы) | ${((trailNeg / nHours) * 100).toFixed(1)}% |`);
console.log(`| вперёд отрицательно (держать было убыточно) | ${((forwardNeg / nHours) * 100).toFixed(1)}% |`);
console.log(`| ПОЛНОТА: убыточных часов поймано | ${forwardNeg ? ((trailNegForwardNeg / forwardNeg) * 100).toFixed(1) : "н-д"}% |`);
console.log(`| ТОЧНОСТЬ: выходов, оказавшихся верными | ${trailNeg ? ((trailNegForwardNeg / trailNeg) * 100).toFixed(1) : "н-д"}% |`);

// Что дала бы монетка: доля убыточных часов и есть точность случайного выхода той же частоты.
console.log(`\nБаза сравнения: правило, выходящее случайно с той же частотой, имело бы точность `
  + `${((forwardNeg / nHours) * 100).toFixed(1)}%, то есть равную доле убыточных часов.`);

const fin = leads.filter((x) => Number.isFinite(x));
const early = fin.filter((x) => x > 0);
console.log(`\n## Упреждение: за сколько часов до убытка трейлинг меняет знак\n`);
console.log(`Эпизодов перехода «вперёд» в минус: ${leads.length}, из них с конечным упреждением ${fin.length}.`);
if (fin.length) {
  console.log(`ЗАБЛАГОВРЕМЕННО (упреждение больше нуля): ${early.length} из ${fin.length} = ${((early.length / fin.length) * 100).toFixed(1)}%.`);
  console.log(`Упреждение в часах: p05 ${q(fin, 0.05).toFixed(0)}, медиана ${q(fin, 0.5).toFixed(0)}, p95 ${q(fin, 0.95).toFixed(0)}.`);
  console.log(`Отрицательное значение это опоздание: правило выходит уже после того, как убыток начался.`);
}

console.log(`\n## По рынкам, десять с наибольшей долей убыточных окон\n`);
console.log(`| рынок | точек | знак совпал | вышли бы | было убыточно |`);
console.log(`|---|---|---|---|---|`);
for (const p of [...perMarket].sort((a, b) => b.fwdNeg - a.fwdNeg).slice(0, 10)) {
  console.log(`| ${p.token} | ${p.n} | ${(p.agree * 100).toFixed(1)}% | ${(p.trailNeg * 100).toFixed(1)}% | ${(p.fwdNeg * 100).toFixed(1)}% |`);
}

console.log(`\n## Границы\n`);
console.log(`- размер зафиксирован $${SIZE} и конфигурация выбрана по трейлингу; ОТБОР правила входа здесь НЕ`);
console.log(`  применён, поэтому в выборку входят и рынки, в которые правило не вошло бы вовсе. Это делает`);
console.log(`  долю убыточных окон ВЫШЕ той, что увидит работающая система, и число «полнота» надо читать`);
console.log(`  как свойство ОЦЕНКИ, а не как ожидаемое поведение бота;`);
console.log(`- «вперёд» это ровно ${H} часов, а живая позиция может закрыться раньше. Более длинный или более`);
console.log(`  короткий взгляд вперёд дал бы другие доли;`);
console.log(`- шаг ${STRIDE} ч огрубляет упреждение до кратных ему величин.`);
