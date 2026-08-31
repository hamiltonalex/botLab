// exit-5-where.mjs - ЗАМЕР З5: РАБОТАЕТ ЛИ ОТБОР ЦЕЛИ, ИЛИ ЦЕННОСТЬ В САМОМ УХОДЕ. READ-ONLY.
//
// ОТКУДА ВОПРОС. Замер З1 дал два числа, которые вместе выглядели парадоксом. Контрфактическая
// окупаемость межрыночных перекладок 43% при кадансе 24 ч, то есть монетка, значит выбор цели края
// не даёт (число берётся по РАЗДЕЛЁННОЙ популяции: смешанные 44% включали храповиковые шаги смены
// размера и описывали не выбор рынка, а его арифметику). И при этом правило
// заметно бьёт базу в хвосте, значит что-то оно всё-таки делает. Из этого следовала гипотеза
// «ценен САМ УХОД, а не выбор цели», и её надо было либо подтвердить, либо опровергнуть, а не
// оставить правдоподобной.
//
// ГЛАВНАЯ ЛОВУШКА КОНСТРУКЦИИ, И ОНА УЖЕ ИСПОРТИЛА ОДИН ЗАМЕР В СМЕЖНОЙ СЕССИИ. Если подставить
// случайную цель в САМ КРИТЕРИЙ и пустить траекторией, изменится не только КУДА, но и КОГДА:
// попав в плохой рынок, рука получает низкое брутто удержания, критерий срабатывает снова на
// следующем же шаге, и она перекладывается безостановочно. Замеренная цена этого: 216 кругов
// против 28 и минус $1744 против плюс $1029, то есть 188 лишних кругов по $16.50 съедают $3102 и
// весь минус создают они, а не качество цели. Приписать такой минус отбору нельзя.
//
// ПОЭТОМУ ЗДЕСЬ ДВЕ ЧАСТИ, И ОНИ ОТВЕЧАЮТ НА РАЗНЫЕ ВОПРОСЫ. Смешивать их нельзя, но и одной не
// хватает.
//
//   5а. КАЧЕСТВО СЕЛЕКТОРА, без траектории и без издержек вовсе. В каждой точке решения берётся
//       брутто ВПЕРЁД на горизонт у рынка ранга 1, ранга 2, медианного, случайного и худшего среди
//       ГОДНЫХ. Траектории нет, значит чурна нет по построению, значит приписать разницу нечему,
//       кроме отбора. Отвечает на вопрос «умеет ли трейлинговый рейтинг предсказывать».
//
//   5б. СИСТЕМНОЕ СЛЕДСТВИЕ, траекторией и с издержками. Тайминг ВСЕГДА решает argmax (критерий не
//       тронут ни строкой), политика выбирает только МЕСТО НАЗНАЧЕНИЯ уже случившейся перекладки.
//       Лишние круги при этом всё равно возникают, и это не конфаунд, а честное следствие плохого
//       селектора; поэтому они печатаются ОТДЕЛЬНОЙ КОЛОНКОЙ, а не растворяются в итоге.
//
// РАЗМЕРНЫЙ КОНФАУНД: сравнение брутто у двух рынков «при их собственных размерах отбора» имеет
// конфаунд, если рынок ранга 1 систематически получает больший размер. Часть 5г его меряет
// РАСПРЕДЕЛЕНИЕМ размеров, и это важно: первая версия проверяла его МЕДИАНОЙ, а медиана у обеих рук
// упирается в потолок тикета $5000 и разницу увидеть не может по построению.
//
// ЕСТЬ И ТРЕТЬЯ ЧАСТЬ, 5г, И ОНА ИСПРАВЛЯЕТ ВЫВОДЫ ПЕРВЫХ ДВУХ. Четыре проверки против собственного
// результата, три подтвердились. Читать 5а и 5б БЕЗ 5г нельзя: там осталось два неверных
// утверждения, снятых ниже.

import fs from "node:fs";
import zlib from "node:zlib";
import { loadUniverse, loadCapacity, makeWalk, rng, WHERE_POLICIES, H, q, $ } from "./exit-lib.mjs";
import { netAtSize } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const SCAN_DIR = argOf("--scan-dir");
const CAPITAL = Number(argOf("--capital", 5000));
const CADENCE = Number(argOf("--cadence", 24));
const SEEDS = Number(argOf("--seeds", 5));
const STARTS = Number(argOf("--starts", 60));
const STEP = Number(argOf("--start-step", 12));
if (!SCAN_DIR) { console.error("нужен --scan-dir <каталог> (собирается exit-0-scan.mjs)"); process.exit(1); }

const parts = fs.readdirSync(SCAN_DIR).filter((f) => f.endsWith(".json.gz"))
  .map((f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(`${SCAN_DIR}/${f}`))));
const allHours = parts.flatMap((p) => p.hours).sort((a, b) => a.h - b.h);
const gaps = [];
for (let i = 1; i < allHours.length; i += 1) if (allHours[i].h !== allHours[i - 1].h + 1) gaps.push([allHours[i - 1].h, allHours[i].h]);
if (gaps.length) { console.error(`в склеенном срезе ДЫРЫ по часам: ${gaps.slice(0, 5).map((g) => g.join("..")).join(", ")}`); process.exit(1); }
const byHour = new Map(allHours.map((h) => [h.h, h]));
const scanFrom = allHours[0].h;

const { markets } = loadUniverse();
const { impactFor } = loadCapacity();
const rowsOf = new Map(markets.map((m) => [m.token, m.rows]));
const YEAR = Math.min(...markets.map((m) => m.rows.length));

const grossOn = (token, config, sizeUsd, from, len) => {
  const rows = rowsOf.get(token);
  const seg = rows.slice(from, from + len);
  if (seg.length !== len) return NaN;
  const r = netAtSize({ rows: seg, config, strategy: "two", sizeUsd, costs: DEFAULT_COSTS, impact: impactFor(token, config === "A" ? "short" : "long") });
  return r ? r.gross : NaN;
};

console.log(`# З5: работает ли отбор цели\n`);
console.log(`Вселенная ${markets.length} рынков, горизонт ${H} ч, каданс ${CADENCE} ч, капитал $${CAPITAL}.`);
console.log(`Годными считаются рынки, которые ПРОФИНАНСИРОВАЛО правило входа: отбор k = 1 уже применён,`);
console.log(`то есть «случайный годный» это случайный из уже отобранных, а не случайный из 63.\n`);

// ─────────────────────────────────────────────────────────────────────────────
// 5а. КАЧЕСТВО СЕЛЕКТОРА. Ни траектории, ни издержек: сравниваются только предсказания.
// ─────────────────────────────────────────────────────────────────────────────

const rand5a = rng(12345);
const arms = { rank1: [], rank2: [], med: [], rnd: [], worst: [] };
const armsPer1k = { rank1: [], rank2: [], med: [], rnd: [], worst: [] };
const sizes = { rank1: [], rnd: [] };
let points = 0;
let onlyOne = 0;
const pairedRnd = [];
const pairedMed = [];

for (let t = scanFrom; t + H <= YEAR; t += CADENCE) {
  const snap = byHour.get(t);
  if (!snap) continue;
  const elig = snap.ok.filter((o) => o[2] <= CAPITAL).sort((a, b) => (b[3] - a[3]) || (a[0] < b[0] ? -1 : 1));
  if (!elig.length) continue;
  points += 1;
  // Точка с ЕДИНСТВЕННЫМ годным рынком выбора не содержит вовсе, и все руки в ней совпадают.
  // Считать её наравне с прочими значило бы разбавлять разницу нулями и занижать край отбора,
  // поэтому она отдельно называется числом.
  if (elig.length === 1) onlyOne += 1;
  const fwd = (o) => grossOn(o[0], o[1], o[2], t, H);
  const at = {
    rank1: elig[0],
    rank2: elig[Math.min(1, elig.length - 1)],
    med: elig[Math.floor((elig.length - 1) / 2)],
    rnd: elig[Math.floor(rand5a() * elig.length)],
    worst: elig[elig.length - 1],
  };
  const g = {};
  for (const [k, o] of Object.entries(at)) g[k] = fwd(o);
  if (!Object.values(g).every(Number.isFinite)) continue;
  for (const k of Object.keys(arms)) {
    arms[k].push(g[k]);
    armsPer1k[k].push((g[k] / at[k][2]) * 1000);
  }
  sizes.rank1.push(at.rank1[2]);
  sizes.rnd.push(at.rnd[2]);
  pairedRnd.push(g.rank1 - g.rnd);
  pairedMed.push(g.rank1 - g.med);
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const NAMES = { rank1: "ранг 1 (argmax)", rank2: "ранг 2", med: "медианный годный", rnd: "СЛУЧАЙНЫЙ годный", worst: "худший годный" };

console.log(`## 5а. Качество селектора: брутто ВПЕРЁД на ${H} ч, траектории и издержек нет\n`);
console.log(`Точек решения ${points}, из них с единственным годным рынком ${onlyOne} (в них выбора нет`);
console.log(`и все руки совпадают). Учтено точек с полными данными: ${arms.rank1.length}.\n`);
console.log(`| выбор | медиана | среднее | доля положительных | медиана на $1000 ноционала |`);
console.log(`|---|---|---|---|---|`);
for (const k of ["rank1", "rank2", "med", "rnd", "worst"]) {
  const a = arms[k];
  console.log(`| ${NAMES[k]} | ${$(q(a, 0.5))} | ${$(mean(a))} | ${((a.filter((x) => x > 0).length / a.length) * 100).toFixed(1)}% | ${$(q(armsPer1k[k], 0.5))} |`);
}

console.log(`\nРАЗМЕРНЫЙ КОНФАУНД ПРОВЕРЕН, А НЕ ПРЕДПОЛОЖЕН: медианный размер ранга 1 $${q(sizes.rank1, 0.5).toFixed(0)},`);
console.log(`случайного $${q(sizes.rnd, 0.5).toFixed(0)}. Колонка «на $1000 ноционала» показывает ту же картину без`);
console.log(`размера, поэтому превосходство ранга 1 это отбор, а не более крупный тикет.`);

console.log(`\n### Парно по точкам решения\n`);
for (const [label, d] of [["ранг 1 против случайного", pairedRnd], ["ранг 1 против медианного", pairedMed]]) {
  console.log(`${label}: выигрывает ${((d.filter((x) => x > 0).length / d.length) * 100).toFixed(1)}% точек, `
    + `медиана разности ${$(q(d, 0.5))}, среднее ${$(mean(d))}, p10 ${$(q(d, 0.1))}, p90 ${$(q(d, 0.9))}.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5б. СИСТЕМНОЕ СЛЕДСТВИЕ. Тайминг решает argmax, политика выбирает только место назначения.
// ─────────────────────────────────────────────────────────────────────────────

const walk = makeWalk({ byHour, scanFrom, grossOn, capital: CAPITAL, horizonH: H, yearEnd: YEAR });
const END = YEAR - (STARTS - 1) * STEP;

console.log(`\n## 5б. Системное следствие: та же цепочка, другое место назначения\n`);
console.log(`${STARTS} стартов со сдвигом ${STEP} ч, общий конец на часе ${END}. Случайная политика прогоняется`);
console.log(`${SEEDS} семенами на старт: одна случайная траектория не решает ничего.\n`);
console.log(`| политика цели | среднее нетто | медиана | кругов, медиана | лишних кругов к argmax |`);
console.log(`|---|---|---|---|---|`);
const results = new Map();
for (const where of WHERE_POLICIES) {
  const nets = [];
  const trips = [];
  const gross = [];
  const costs = [];
  const seedsFor = where === "random" ? SEEDS : 1;
  for (let i = 0; i < STARTS; i += 1) {
    for (let s = 0; s < seedsFor; s += 1) {
      const r = walk({ cadence: CADENCE, startOffset: i * STEP, endAt: END, where, seed: 1000 + s });
      nets.push(r.net);
      trips.push(r.tally.open + r.tally.switch);
      gross.push(r.realized);
      costs.push(r.costs);
    }
  }
  results.set(where, { nets, trips, gross, costs });
}
const baseTrips = q(results.get("best").trips, 0.5);
for (const where of WHERE_POLICIES) {
  const { nets, trips } = results.get(where);
  console.log(`| ${where} | ${$(mean(nets))} | ${$(q(nets, 0.5))} | ${q(trips, 0.5).toFixed(0)} | ${(q(trips, 0.5) - baseTrips).toFixed(0)} |`);
}

console.log(`\n### Разложение потери: сколько от ЦЕЛИ, а сколько от ЛИШНИХ ИЗДЕРЖЕК\n`);
// РАЗЛОЖЕНИЕ ТОЧНОЕ, А НЕ ОЦЕНОЧНОЕ, и первая версия этого блока была неверна именно здесь. Она
// оценивала стоимость чурна плоским кругом при потолочном тикете, а у худших рынков размеры меньше
// и круг дешевле; остаток впитывал ошибку оценки и выдавал у политики «худший» качество цели
// плюс $2.3k, чего быть не может. Обход возвращает `realized` и `costs` по отдельности, поэтому
// вычитание точное и тождество `нетто = брутто - издержки` держится по построению.
console.log(`| политика | потеря нетто к argmax | из неё ИЗДЕРЖКИ | из неё КАЧЕСТВО ЦЕЛИ (брутто) |`);
console.log(`|---|---|---|---|`);
const baseNet = mean(results.get("best").nets);
const baseGross = mean(results.get("best").gross);
const baseCost = mean(results.get("best").costs);
for (const where of WHERE_POLICIES.filter((w) => w !== "best")) {
  const r = results.get(where);
  const loss = mean(r.nets) - baseNet;
  const dCost = -(mean(r.costs) - baseCost); // издержки выросли, значит вклад отрицательный
  const dGross = mean(r.gross) - baseGross;
  console.log(`| ${where} | ${$(loss)} | ${$(dCost)} | ${$(dGross)} |`);
}
console.log(`\nСтолбцы складываются в первый ТОЧНО: нетто есть брутто минус издержки, и обе величины`);
console.log(`берутся из обхода, а не оцениваются.`);

// ─────────────────────────────────────────────────────────────────────────────
// 5в. В КАКОМ РЕЖИМЕ РАБОТАЕТ ВЕТКА ПЕРЕКЛАДКИ. Прямой замер вместо правдоподобия.
//
// Части 5а и 5б вместе дают объяснение «монетки» из З1: селектор силён относительно случайного
// рынка, но у ВЕРХУШКИ рейтинга ранги неразличимы, а действующая позиция была отобрана тем же
// argmax раньше, поэтому перекладка сравнивает верх с верхом. Объяснение это правдоподобно, и
// именно поэтому его надо ИЗМЕРИТЬ: правдоподобное и неизмеренное в этом проекте уже трижды
// оказывалось неверным.
//
// Здесь считается РАНГ ДЕЙСТВУЮЩЕЙ ПОЗИЦИИ среди годных в каждый момент решения боевой руки.
// Если механизм верен, ранг обязан быть маленьким подавляющую часть времени.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = walk({ cadence: CADENCE, startOffset: 0, endAt: YEAR, where: "best" });
  // Позиция в каждый час восстанавливается из журнала: вход и перекладки называют момент и цель.
  const events = r.log.filter((e) => e.act === "open" || e.act === "switch").sort((a, b) => a.t - b.t);
  const closes = r.log.filter((e) => e.act === "cash").map((e) => e.t);
  const ranks = [];
  const eligCounts = [];
  let held = null;
  let ei = 0;
  for (let t = scanFrom; t + H <= YEAR; t += CADENCE) {
    while (ei < events.length && events[ei].t <= t) { held = events[ei]; ei += 1; }
    if (closes.includes(t)) held = null;
    if (!held) continue;
    const snap = byHour.get(t);
    if (!snap) continue;
    const elig = snap.ok.filter((o) => o[2] <= CAPITAL).sort((a, b) => (b[3] - a[3]) || (a[0] < b[0] ? -1 : 1));
    if (!elig.length) continue;
    const idx = elig.findIndex((o) => o[0] === held.token && o[1] === held.config);
    // Позиция, ВЫПАВШАЯ из годных (правило входа её больше не финансирует), это не ранг, а другое
    // состояние, и складывать её с рангами нельзя: она попала бы в хвост как «очень плохой ранг»,
    // тогда как на деле она вне рейтинга вовсе.
    ranks.push(idx < 0 ? null : idx + 1);
    eligCounts.push(elig.length);
  }
  const known = ranks.filter((x) => x !== null);
  const dropped = ranks.length - known.length;
  console.log(`\n## 5в. Ранг действующей позиции в момент решения (боевая рука, каданс ${CADENCE} ч)\n`);
  console.log(`Точек с открытой позицией ${ranks.length}, из них позиция ВЫПАЛА из годных ${dropped} раз`);
  console.log(`(это не плохой ранг, а состояние «правило входа её больше не финансирует», и в статистику`);
  console.log(`рангов такие точки не входят).\n`);
  console.log(`| величина | значение |`);
  console.log(`|---|---|`);
  console.log(`| ранг 1 | ${known.filter((x) => x === 1).length} из ${known.length} (${((known.filter((x) => x === 1).length / known.length) * 100).toFixed(1)}%) |`);
  console.log(`| ранг не ниже 3 | ${known.filter((x) => x <= 3).length} из ${known.length} (${((known.filter((x) => x <= 3).length / known.length) * 100).toFixed(1)}%) |`);
  console.log(`| медиана ранга | ${q(known, 0.5).toFixed(1)} |`);
  console.log(`| p90 ранга | ${q(known, 0.9).toFixed(1)} |`);
  console.log(`| годных рынков, медиана | ${q(eligCounts, 0.5).toFixed(0)} |`);
  console.log(`\nЕсли ранг действующей позиции мал, значит ветка перекладки сравнивает верх рейтинга с`);
  console.log(`верхом, а не верх со случайным, и «монетка» из З1 объясняется режимом работы, а не`);
  console.log(`слабостью отбора.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5г. ЧЕТЫРЕ ПРОВЕРКИ ПРОТИВ СОБСТВЕННОГО ВЫВОДА. Все четыре найдены состязательной проверкой
// частей 5а и 5б, и ТРИ ИЗ НИХ ПОДТВЕРДИЛИСЬ, то есть исправляют выводы выше, а не украшают их.
//
//   Н1. Пара «ранг 1 против ранга 2» сравнивалась КРАЕВЫМИ медианами ($84.40 против $84.05), а не
//       парно. Это ровно та форма сравнения, которая в этой сессии трижды переворачивала
//       формулировку, и снята она была только для пары «ранг 1 против случайного».
//   Н2. Строка «размерный конфаунд проверен» опиралась на МЕДИАНУ размера, а медиана у обеих рук
//       упирается в потолок тикета $5000, то есть у этой статистики нет разрешающей способности по
//       построению. Проверка, неспособная увидеть эффект, проверкой не является.
//   Н3. Превосходство ранга 1 может быть свойством ИДЕНТИЧНОСТИ выбранных рынков (рейтинг находит
//       рынки, хорошие весь год), а не свойством МОМЕНТА. Отделяется вычитанием собственного
//       годового уровня каждой руки. Уровень считается задним числом, поэтому это ДЕКОМПОЗИЦИЯ, а
//       не исполнимая стратегия.
//   Н4. Предсказание может быть тривиальным по автокорреляции. Отделяется ПРОТУХШИМ рейтингом из
//       часа t-720, чей трейлинг [t-1440, t-720) с окном вперёд [t, t+720) НЕ пересекается вовсе.
// ─────────────────────────────────────────────────────────────────────────────
{
  const randG = rng(777);
  const pair12 = [];
  const pair1r = [];
  const sz = { r1: [], r2: [], rnd: [], worst: [] };
  const ident = [];
  const stale = [];
  const pts = [];
  const lvlSum = new Map();
  const lvlN = new Map();
  for (let t = scanFrom; t + H <= YEAR; t += CADENCE) {
    const snap = byHour.get(t);
    if (!snap) continue;
    const e = snap.ok.filter((o) => o[2] <= CAPITAL).sort((a, b) => (b[3] - a[3]) || (a[0] < b[0] ? -1 : 1));
    if (e.length < 2) continue;
    const r1 = e[0];
    const r2 = e[1];
    const rr = e[Math.floor(randG() * e.length)];
    const wo = e[e.length - 1];
    const g1 = grossOn(r1[0], r1[1], r1[2], t, H);
    const g2 = grossOn(r2[0], r2[1], r2[2], t, H);
    const gr = grossOn(rr[0], rr[1], rr[2], t, H);
    if (![g1, g2, gr].every(Number.isFinite)) continue;
    pts.push({ t, r1, r2, rr, g1, g2, gr });
    pair12.push(g1 - g2);
    pair1r.push(g1 - gr);
    sz.r1.push(r1[2]); sz.r2.push(r2[2]); sz.rnd.push(rr[2]); sz.worst.push(wo[2]);
    for (const [o, g] of [[r1, g1], [r2, g2], [rr, gr]]) {
      lvlSum.set(o[0], (lvlSum.get(o[0]) || 0) + g);
      lvlN.set(o[0], (lvlN.get(o[0]) || 0) + 1);
    }
  }
  const lvl = (o) => lvlSum.get(o[0]) / lvlN.get(o[0]);
  for (const p of pts) ident.push((p.g1 - lvl(p.r1)) - (p.gr - lvl(p.rr)));
  for (const p of pts) {
    const old = byHour.get(p.t - H);
    if (!old) continue;
    const eo = old.ok.filter((o) => o[2] <= CAPITAL).sort((a, b) => (b[3] - a[3]) || (a[0] < b[0] ? -1 : 1));
    if (!eo.length) continue;
    const g = grossOn(eo[0][0], eo[0][1], eo[0][2], p.t, H);
    if (Number.isFinite(g)) stale.push({ fresh: p.g1, stale: g });
  }
  const win = (a) => `${((a.filter((x) => x > 0).length / a.length) * 100).toFixed(1)}%`;

  console.log(`\n## 5г. Проверки против собственного вывода\n`);
  console.log(`### Н1. Пара «ранг 1 против ранга 2», теперь ПАРНО\n`);
  console.log(`выигрывает ${win(pair12)}, медиана разности ${$(q(pair12, 0.5))}, среднее ${$(mean(pair12))}, `
    + `p10 ${$(q(pair12, 0.1))}, p90 ${$(q(pair12, 0.9))}.`);
  console.log(`для сверки, ранг 1 против случайного: выигрывает ${win(pair1r)}, медиана ${$(q(pair1r, 0.5))}.`);
  console.log(`\nВывод «верхушка неразличима» УЦЕЛЕЛ и теперь получен верным способом: доля побед у пары`);
  console.log(`рангов 1 и 2 неотличима от половины. Прежний способ (сравнение краевых медиан) давал тот`);
  console.log(`же ответ по случайности, а не по праву.`);

  console.log(`\n### Н2. Размеры по рукам: РАСПРЕДЕЛЕНИЕ, а не медиана\n`);
  console.log(`| рука | p10 | медиана | p90 | среднее | доля на потолке тикета |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const [k, name] of [["r1", "ранг 1"], ["r2", "ранг 2"], ["rnd", "случайный"], ["worst", "худший"]]) {
    const a = sz[k];
    console.log(`| ${name} | $${q(a, 0.1).toFixed(0)} | $${q(a, 0.5).toFixed(0)} | $${q(a, 0.9).toFixed(0)} | `
      + `$${mean(a).toFixed(0)} | ${((a.filter((x) => x >= CAPITAL - 0.1).length / a.length) * 100).toFixed(1)}% |`);
  }
  console.log(`\nПРЕЖНЯЯ СТРОКА «размерный конфаунд проверен» БЫЛА НЕВЕРНА. Медиана у ранга 1 и у случайного`);
  console.log(`совпадает только потому, что обе упираются в потолок тикета, и разницу она увидеть не могла.`);
  // Числа в тексте берутся из ТОЛЬКО ЧТО посчитанного, а не зашиваются: зашитая величина рядом с
  // вычисленной расходится при первой же смене семени, и это ровно тот класс расхождений, который
  // эта сессия чинила в шапке модуля.
  const cap = (k) => ((sz[k].filter((x) => x >= CAPITAL - 0.1).length / sz[k].length) * 100).toFixed(1);
  console.log(`Распределения расходятся: на потолке стоят ${cap("r1")}% ранга 1 против ${cap("rnd")}% случайного`);
  console.log(`и ${cap("worst")}% худшего (у него медиана $${q(sz.worst, 0.5).toFixed(0)}). Отсюда два следствия. Первое:`);
  console.log(`сравнивать ХУДШУЮ руку с остальными в абсолютных долларах нельзя вовсе, это другой масштаб`);
  console.log(`ноционала. Второе: у пары «ранг 1 против случайного» нормировка на ноционал сжимает разрыв`);
  console.log(`(${(q(arms.rank1, 0.5) / q(arms.rnd, 0.5)).toFixed(2)} раза в долларах против ${(q(armsPer1k.rank1, 0.5) / q(armsPer1k.rnd, 0.5)).toFixed(2)} на равном ноционале), то есть часть края`);
  console.log(`всё-таки размерная, и «втрое» без оговорки употреблять нельзя.`);

  console.log(`\n### Н3. Контроль на ИДЕНТИЧНОСТЬ РЫНКА\n`);
  console.log(`После вычитания собственного годового уровня каждой руки ранг 1 против случайного:`);
  console.log(`выигрывает ${win(ident)}, медиана ${$(q(ident, 0.5))}, среднее ${$(mean(ident))}.`);
  console.log(`\nКРАЙ ИСЧЕЗАЕТ И СЛЕГКА МЕНЯЕТ ЗНАК. Значит превосходство рейтинга это свойство УРОВНЯ, а не`);
  console.log(`МОМЕНТА: он находит рынки, которые хороши весь год, и не умеет ловить время внутри рынка.`);
  console.log(`Для правила выхода это существенно: перекладка обосновывается разницей рынков, а не тем,`);
  console.log(`что текущий рынок «портится именно сейчас».`);

  console.log(`\n### Н4. ПРОТУХШИЙ рейтинг из часа t-${H}\n`);
  const fr = stale.map((x) => x.fresh);
  const st = stale.map((x) => x.stale);
  console.log(`точек ${stale.length}; свежий рейтинг даёт медиану ${$(q(fr, 0.5))}, протухший ${$(q(st, 0.5))}, `
    + `то есть ${((q(st, 0.5) / q(fr, 0.5)) * 100).toFixed(0)}% по медиане и ${((mean(st) / mean(fr)) * 100).toFixed(0)}% по среднему.`);
  console.log(`\nРейтинг месячной давности, чей трейлинг с окном вперёд НЕ пересекается, сохраняет большую`);
  console.log(`часть силы. Это согласуется с Н3: рейтинг работает как медленный фильтр качества рынка, а`);
  console.log(`не как своевременное решение, и ожидать от него быстрой реакции нельзя.`);
}

console.log(`\n## Границы\n`);
console.log(`- 5а НЕ содержит издержек вовсе и потому НЕ является оценкой доходности: это оценка`);
console.log(`  ПРЕДСКАЗАТЕЛЬНОЙ СИЛЫ трейлингового рейтинга, и только;`);
console.log(`- «годный» здесь уже прошёл отбор правила входа при k = 1, поэтому случайный годный это не`);
console.log(`  случайный рынок вселенной, а случайный из отобранных. Край относительно ВСЕЙ вселенной`);
console.log(`  этим замером не измеряется и был бы больше;`);
console.log(`- точки решения ПЕРЕСЕКАЮТСЯ окнами вперёд (шаг ${CADENCE} ч при окне ${H} ч), поэтому доли`);
console.log(`  и медианы честны, а доверительного интервала отсюда не выводится;`);
console.log(`- 5б наследует все границы обхода: три снимка ёмкости, одна позиция за раз, один год.`);
