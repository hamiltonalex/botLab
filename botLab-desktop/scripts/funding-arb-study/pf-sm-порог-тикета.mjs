// pf-sm-порог-тикета.mjs - ЖЁСТКИЙ ПОЛ ПО РАЗМЕРУ И ФОРМА ПРОЦЕНТА ПО КАПИТАЛУ. READ-ONLY.
//
// ПОСТАНОВКА. Депозит связан СВЕРХУ внешней причиной ($500..$5000), значит вопрос не «сколько
// выжать вообще», а «сколько выжать при связанном капитале» и «где именно кончается механизм».
// Снизу капитал связан правилом входа: minTicketUsd = $500 в FA_SIZING_DEFAULTS, ниже билета
// позиция не открывается вовсе. Но пол на самом деле НЕ равен $500, и это первое, что тут меряется:
// распределитель ходит по вогнутой оболочке кривой нетто, её первый узел лежит на сетке
// logGrid(10, ..., шаг 0.1 декады) и обрезан снизу билетом, поэтому дешевле $501.19 узла не
// существует ФИЗИЧЕСКИ, а у конкретного рынка первый узел оболочки бывает и на $2511.
//
// ЧТО ЗДЕСЬ НЕ РЕШАЕТСЯ. Ходок не переписывается: и отбор, и размер, и распределение считает
// движок (`allocateCapital` + `FA_SIZING_DEFAULTS`), а руки гоняет `walk` из pf-walk.mjs. Здесь
// только запуск и сведение чисел.
//
// ГЛАВНЫЙ ВОПРОС РАЗДЕЛА В. Процент годовых падает с ростом капитала. Это может быть разбавление
// (доход = pot*S/(B+S) вогнут по S, малый размер ловит большую долю ставки), а может быть артефакт
// отбора: при малом капитале выбирается ДРУГОЙ рынок. Второе проверяется прямо, сравнением
// траекторий держания при $500 и $5000, а не рассуждением.

import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H, q, $ } from "./pf-lib.mjs";
import { allocateCapital, FA_SIZING_DEFAULTS } from "../../src/engine/fa/sizing.js";

const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const SCAN = argOf("--scan");
if (!SCAN) { console.error("--scan обязателен"); process.exit(1); }
const scan = loadScan(SCAN);
const env = makeEnv();

const STARTS = Number(argOf("--starts", 40));
const STEP = Number(argOf("--step", 12));
const CADENCE = Number(argOf("--cadence", 24));
const YEAR = env.YEAR;
const LEN = YEAR - (H + (STARTS - 1) * STEP);
const ANN = 8760 / LEN;
const mean = (a) => (a.length ? a.reduce((u, v) => u + v, 0) / a.length : NaN);
const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(2)}%` : "н-д");

// Повторение `candidates`/`target` из ходока: те функции не экспортированы, а вторая арифметика
// размера здесь не заводится. Оба шага делает движок, отличается только точка вызова.
function armsOf(ok) {
  return ok.map((c) => ({ token: c.k, config: c.c, netUsd: c.n, hull: c.h.map(([sizeUsd, net]) => ({ sizeUsd, net })) }));
}
function topK(arms, kmax) {
  if (!Number.isFinite(kmax)) return arms;
  return [...arms].sort((a, b) => b.netUsd - a.netUsd).slice(0, kmax);
}
function allocOf(ok, capital, kmax) {
  const { alloc, usedUsd } = allocateCapital(topK(armsOf(ok), kmax), capital, FA_SIZING_DEFAULTS);
  return { alloc, usedUsd };
}
// Первый узел оболочки: минимальный размер, которым в этот рынок вообще можно войти.
const firstStep = (a) => (a.hull && a.hull.length > 1 ? a.hull[1].sizeUsd : Infinity);

const HOURS = [];
for (let t = H; t <= YEAR; t += CADENCE) if (scan.has(t)) HOURS.push(t);

console.log(`# Пол по размеру и форма процента доходности по капиталу\n`);
console.log(`Вселенная 63 рынка, год ${H}..${YEAR} ч, часов решения при кадансе ${CADENCE} ч: ${HOURS.length}.`);
console.log(`minTicketUsd = $${FA_SIZING_DEFAULTS.minTicketUsd}, ticketCapUsd = $${FA_SIZING_DEFAULTS.ticketCapUsd}, горизонт ${FA_SIZING_DEFAULTS.horizonH} ч.\n`);

// ─────────────────────────────────────────────────────────────────────────────
// А. ЧТО ПРОИСХОДИТ ВНИЗУ: сколько рынков проходит отбор и сколько из них можно ОПЛАТИТЬ.
// ─────────────────────────────────────────────────────────────────────────────
const passed = HOURS.map((t) => scan.get(t).length);
const armsByHour = HOURS.map((t) => armsOf(scan.get(t)));
const withHull = armsByHour.map((a) => a.filter((x) => x.hull.length > 1).length);
const cheapest = armsByHour.map((a) => Math.min(...a.map(firstStep)));
const topFirst = armsByHour.map((a) => { const k = topK(a, 1); return k.length ? firstStep(k[0]) : Infinity; });

console.log(`## А1. Отбор от капитала НЕ зависит, оплата зависит\n`);
console.log(`Кривые в разведке посчитаны при безлимитном капитале, поэтому число прошедших отбор рынков`);
console.log(`одинаково при любом депозите. Ниже квантили по ${HOURS.length} часам решения.\n`);
console.log(`| величина | мин | p10 | медиана | p90 | макс |`);
console.log(`|---|---|---|---|---|---|`);
const row = (name, a, fmt) => console.log(`| ${name} | ${fmt(Math.min(...a))} | ${fmt(q(a, 0.1))} | ${fmt(q(a, 0.5))} | ${fmt(q(a, 0.9))} | ${fmt(Math.max(...a))} |`);
row("рынков прошло отбор", passed, (x) => x.toFixed(0));
row("из них с оболочкой (>1 узла)", withHull, (x) => x.toFixed(0));
row("самый дешёвый вход, $", cheapest.filter(Number.isFinite), (x) => `$${x.toFixed(0)}`);
row("вход в ЛУЧШИЙ рынок часа, $", topFirst.filter(Number.isFinite), (x) => `$${x.toFixed(0)}`);

const CAPS_A = [400, 500, 501.19, 600, 750, 1000];
console.log(`\n## А2. Пять капиталов под порогом и рядом с ним\n`);
console.log(`«Открывается» считается по часам решения: доля часов, в которые распределитель выдал хотя бы`);
console.log(`один размер. Рука hold-1/rule-1 берёт ЛУЧШИЙ рынок часа по нетто (kmax = 1), поэтому у неё`);
console.log(`своя колонка: дешёвый рынок в этот час может существовать, но рука его не смотрит.\n`);
console.log(`| капитал | рынков по карману (из прошедших отбор) | одна позиция: часов с входом | медиана размера | портфель: рынков | портфель: занято $ |`);
console.log(`|---|---|---|---|---|---|`);
for (const cap of CAPS_A) {
  let afford = [], opened = 0, sizes = [], pfN = [], pfUsd = [];
  for (let i = 0; i < HOURS.length; i += 1) {
    const arms = armsByHour[i];
    afford.push(arms.filter((a) => firstStep(a) <= cap).length);
    const a1 = allocOf(scan.get(HOURS[i]), cap, 1);
    if (a1.alloc.size) { opened += 1; sizes.push([...a1.alloc.values()][0]); }
    const ap = allocOf(scan.get(HOURS[i]), cap, Infinity);
    pfN.push(ap.alloc.size); pfUsd.push(ap.usedUsd);
  }
  console.log(`| $${cap} | медиана ${q(afford, 0.5).toFixed(0)}, макс ${Math.max(...afford)} | ${opened}/${HOURS.length} = ${(100 * opened / HOURS.length).toFixed(1)}% | ${sizes.length ? `$${q(sizes, 0.5).toFixed(0)}` : "позиции нет"} | медиана ${q(pfN, 0.5).toFixed(0)}, макс ${Math.max(...pfN)} | медиана $${q(pfUsd, 0.5).toFixed(0)} |`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Б. РАЗВЁРТКА ПО КАПИТАЛУ: где лежит максимум ПРОЦЕНТА.
// ─────────────────────────────────────────────────────────────────────────────
const LEVELS = 12;
const CAPS_B = [];
for (let i = 0; i < LEVELS; i += 1) CAPS_B.push(Math.round(500 * 10 ** (i / (LEVELS - 1))));

function runArm(capital, mode) {
  const net = [], gross = [], cost = [], opens = [], used = [], toks = [], logs = [];
  for (let s = 0; s < STARTS; s += 1) {
    const first = H + s * STEP;
    const r = walk({ scan, env, capital, cadence: CADENCE, mode, first, last: first + LEN });
    net.push(r.net); gross.push(r.realized); cost.push(r.costs); opens.push(r.tally.open);
    const sets = r.log.filter((e) => e.act === "set");
    used.push(sets.length ? q(sets.map((e) => e.usd), 0.5) : 0);
    toks.push(sets.length ? sets[0].tokens : "нет входа");
    logs.push(r.log);
  }
  return { net, gross, cost, opens, used, toks, logs };
}

console.log(`\n## Б. Процент годовых при движении капитала $500..$5000\n`);
console.log(`${STARTS} стартов со сдвигом ${STEP} ч, длина каждого ${LEN} ч, годовой множитель ${ANN.toFixed(4)}, каданс ${CADENCE} ч.`);
console.log(`Процент считается от НОМИНАЛЬНОГО депозита и отдельно от ЗАДЕЙСТВОВАННЫХ денег: одна позиция`);
console.log(`не может взять больше своего оптимума, остаток простаивает, и без второй колонки простой был бы`);
console.log(`приписан механизму.\n`);
const B = {};
for (const mode of ["hold-1", "rule-1"]) {
  console.log(`### ${mode}\n`);
  console.log(`| капитал | нетто год (медиана) | % годовых | % от занятых денег | занято $ (медиана) | среднее нетто год | стартов в плюсе | кругов (медиана) | различных первых рынков |`);
  console.log(`|---|---|---|---|---|---|---|---|---|`);
  B[mode] = {};
  for (const cap of CAPS_B) {
    const r = runArm(cap, mode);
    const y = q(r.net, 0.5) * ANN;
    const ym = mean(r.net) * ANN;
    const u = q(r.used, 0.5);
    B[mode][cap] = { y, ym, u, r };
    console.log(`| $${cap} | $${y.toFixed(2)} | **${(100 * y / cap).toFixed(2)}%** | ${u > 0 ? `${(100 * y / u).toFixed(2)}%` : "н-д"} | $${u.toFixed(0)} | $${ym.toFixed(2)} | ${r.net.filter((x) => x > 0).length}/${STARTS} | ${q(r.opens, 0.5).toFixed(0)} | ${new Set(r.toks).size} |`);
  }
  console.log("");
}

// ─────────────────────────────────────────────────────────────────────────────
// В. АРТЕФАКТ ОТБОРА ИЛИ РАЗБАВЛЕНИЕ: совпадают ли выбранные рынки.
// ─────────────────────────────────────────────────────────────────────────────
// Восстановление держания по журналу: состав, установленный в час t, держится до следующей записи.
function heldSeries(log, hours) {
  const out = new Map();
  let cur = "";
  let li = 0;
  const ev = [...log].sort((a, b) => a.t - b.t);
  for (const t of hours) {
    while (li < ev.length && ev[li].t <= t) { cur = ev[li].act === "set" ? ev[li].tokens : ""; li += 1; }
    out.set(t, cur);
  }
  return out;
}

console.log(`## В. Один ли рынок выбирается при $500 и при $5000\n`);
console.log(`ПРЯМАЯ ПРОВЕРКА, а не рассуждение: при kmax = 1 кандидат отбирается по нетто ПРИ БЕЗЛИМИТНОМ`);
console.log(`капитале, то есть до того, как депозит вообще вошёл в расчёт. Значит расхождение может прийти`);
console.log(`только оттуда, что лучший рынок часа оказался НЕ ПО КАРМАНУ и вход не состоялся, а следующая`);
console.log(`попытка пришлась на другой час с другим лидером.\n`);
console.log(`| рука | стартов с совпадением первого рынка | часов держания совпало | часов, где $500 пуст, а $5000 в позиции | обратно |`);
console.log(`|---|---|---|---|---|`);
for (const mode of ["hold-1", "rule-1"]) {
  const lo = B[mode][500].r, hi = B[mode][5000].r;
  let sameFirst = 0, same = 0, tot = 0, loEmpty = 0, hiEmpty = 0;
  for (let s = 0; s < STARTS; s += 1) {
    if (lo.toks[s] === hi.toks[s]) sameFirst += 1;
    const first = H + s * STEP, last = first + LEN;
    const hrs = [];
    for (let t = first; t <= last; t += CADENCE) if (scan.has(t)) hrs.push(t);
    const a = heldSeries(lo.logs[s], hrs), b = heldSeries(hi.logs[s], hrs);
    for (const t of hrs) {
      tot += 1;
      const x = a.get(t), y = b.get(t);
      if (x === y) same += 1;
      if (!x && y) loEmpty += 1;
      if (x && !y) hiEmpty += 1;
    }
  }
  console.log(`| ${mode} | ${sameFirst}/${STARTS} | ${same}/${tot} = ${(100 * same / tot).toFixed(1)}% | ${loEmpty} | ${hiEmpty} |`);
}

console.log(`\n### Какие рынки ловятся первыми (сверка списков)\n`);
for (const mode of ["hold-1", "rule-1"]) {
  const lo = B[mode][500].r, hi = B[mode][5000].r;
  const cnt = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}x${n}`).join(" "); };
  console.log(`  ${mode} $500 : ${cnt(lo.toks)}`);
  console.log(`  ${mode} $5000: ${cnt(hi.toks)}`);
}

// Размер при одном и том же рынке: сколько именно долларов встаёт в позицию на каждом капитале.
console.log(`\n### Размер позиции при одном и том же лучшем рынке (первый час каждого старта)\n`);
console.log(`| капитал | медиана размера первой позиции | доля капитала в работе |`);
console.log(`|---|---|---|`);
for (const cap of CAPS_B) {
  const sizes = [];
  for (let s = 0; s < STARTS; s += 1) {
    const t = H + s * STEP;
    if (!scan.has(t)) continue;
    const a = allocOf(scan.get(t), cap, 1);
    sizes.push(a.usedUsd);
  }
  const m = q(sizes, 0.5);
  console.log(`| $${cap} | $${m.toFixed(0)} | ${(100 * m / cap).toFixed(1)}% |`);
}
