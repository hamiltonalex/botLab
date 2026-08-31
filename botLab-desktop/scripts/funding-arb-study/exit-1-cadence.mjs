// exit-1-cadence.mjs - ЗАМЕРЫ З1 И З2: КАДАНС РЕШЕНИЙ И ДОСТИЖИМОСТЬ ВЕТОК. READ-ONLY.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ.
//   З1. Меняет ли каданс (решать раз в 1, 24, 168 часов) число решений и итог. Бюджет измерен и
//       мал: 8.39 круга в год у BTC two-B на $2000, и каждое лишнее решение стоит круга.
//   З2. Достижима ли ветка «в кэш» вообще. Отбор входа при k = 1 уже требует, чтобы нетто окупало
//       круг, и возможно, что рынок, прошедший вход, до отрицательного брутто просто не доживает.
//       Ветка, недостижимая на рабочем наборе, обосновывает несуществующую ситуацию.
//   Плюс: сколько раз лучшая альтернатива это ТОТ ЖЕ рынок другим размером. Это тот случай,
//       который в конструкции защищён отдельно, и его частота решает, нужна ли о нём речь вообще.
//
// КРИТЕРИЙ СОБИРАЕТСЯ ЗДЕСЬ ИЗ ТРЁХ ЧИСЕЛ И МАКСИМУМА, и своей арифметики у него нет:
//   держать    = брутто текущей позиции на трейлинге, `netAtSize().gross`;
//   в кэш      = ноль;
//   переложить = нетто лучшей альтернативы, `bestSizeForMarket().netUsd` (посчитано в exit-0-scan).
// Стоимость закрытия текущей позиции в сравнение НЕ входит: она платится в любой ветке и сокращается.
//
// ЧЕСТНОСТЬ ВРЕМЕНИ. Решение в час t принимается по данным ДО t. Реализованный доход считается по
// строкам ПОСЛЕ t и в решение не заходит. Смешать эти ряды значит дать правилу заглянуть вперёд.
//
// БУХГАЛТЕРИЯ. Открывая позицию размера S, сразу списываем ПОЛНЫЙ круг `costAtSize(S)`, дальше
// удержание бесплатно и закрытие бесплатно. Это ровно та бухгалтерия, в которой посчитано `netUsd`
// правила входа, поэтому решения и итог считаются в одних деньгах.

import fs from "node:fs";
import zlib from "node:zlib";
import { loadUniverse, loadCapacity, makeWalk, H, q, $, iso } from "./exit-lib.mjs";
import { netAtSize } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const SCAN = argOf("--scan");
const SCAN_DIR = argOf("--scan-dir");
const CADENCES = String(argOf("--cadences", "1,24,168,720")).split(",").map(Number);
const CAPITAL = Number(argOf("--capital", 5000));
if (!SCAN && !SCAN_DIR) { console.error("нужен --scan <файл> или --scan-dir <каталог> (собирается exit-0-scan.mjs)"); process.exit(1); }

// Счёт вселенной режется на отрезки часов и раздаётся процессам, поэтому кусков может быть много.
// Склейка требует, чтобы часы шли БЕЗ ДЫР: пропущенный час сдвинул бы каданс и дал бы правдоподобную
// неверную картину, а молчаливая склейка этого не показала бы.
const parts = SCAN_DIR
  ? fs.readdirSync(SCAN_DIR).filter((f) => f.endsWith(".json.gz")).map((f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(`${SCAN_DIR}/${f}`))))
  : [JSON.parse(zlib.gunzipSync(fs.readFileSync(SCAN)))];
const allHours = parts.flatMap((p) => p.hours).sort((a, b) => a.h - b.h);
const scan = { from: allHours[0].h, to: allHours[allHours.length - 1].h, hours: allHours };
const gaps = [];
for (let i = 1; i < allHours.length; i += 1) if (allHours[i].h !== allHours[i - 1].h + 1) gaps.push([allHours[i - 1].h, allHours[i].h]);
if (gaps.length) { console.error(`в склеенном срезе ДЫРЫ по часам: ${gaps.slice(0, 5).map((g) => g.join("..")).join(", ")}${gaps.length > 5 ? ` и ещё ${gaps.length - 5}` : ""}`); process.exit(1); }
const byHour = new Map(allHours.map((h) => [h.h, h]));
const { markets } = loadUniverse();
const { impactFor } = loadCapacity();
const rowsOf = new Map(markets.map((m) => [m.token, m.rows]));
const YEAR = Math.min(...markets.map((m) => m.rows.length));

// Брутто позиции на произвольном отрезке строк. Тот же `netAtSize`, что у правила входа: своей
// арифметики начисления здесь нет ни строки.
const grossOn = (token, config, sizeUsd, from, len) => {
  const rows = rowsOf.get(token);
  const seg = rows.slice(from, from + len);
  if (seg.length !== len) return NaN;
  const r = netAtSize({ rows: seg, config, strategy: "two", sizeUsd, costs: DEFAULT_COSTS, impact: impactFor(token, config === "A" ? "short" : "long") });
  return r ? r.gross : NaN;
};

// ОБХОД ЖИВЁТ В БИБЛИОТЕКЕ, А НЕ ЗДЕСЬ. Замеров, которым он нужен, стало два (каданс и вопрос
// «КУДА уходить»), и две копии цепочки решений означали бы две её реализации. Здесь остаётся только
// вооружение: снабжение, капитал и горизонт.
//
// ОКНО ВЕТКИ КЭША отдельным параметром, и это не украшение. Ветка кэша сравнивает брутто с нулём,
// то есть пользуется только ЗНАКОМ, а знак инвариантен к длине окна; ветка перекладки сравнивает
// брутто с НЕТТО альтернативы, посчитанным правилом входа на его горизонте, и там длина окна
// связана. Поэтому у кэша окно может быть своим, и здесь оно меряется ДЕНЬГАМИ.
//
// `endAt` держит ВСЕ прогоны ОДНОЙ ДЛИНЫ. Без него старт со смещением идёт короче на величину
// смещения, и размах итога получает механическую добавку от длины: при 12 стартах с шагом 60 ч
// последний прогон был бы на 660 ч (8.2%) короче первого, и около 42% размаха у правила создавала
// бы разная длина, а не поведение.
const walkRaw = makeWalk({ byHour, scanFrom: scan.from, grossOn, capital: CAPITAL, horizonH: H, yearEnd: YEAR });
const walk = (cadence, cashWindow = H, startOffset = 0, mode = "rule", endAt = YEAR) =>
  walkRaw({ cadence, cashWindow, startOffset, mode, endAt });

console.log(`# З1 и З2: каданс решений и достижимость веток\n`);
console.log(`Часы решений ${scan.from}..${scan.to}, вселенная ${markets.length} рынков, горизонт ${H} ч,`);
console.log(`капитал $${CAPITAL} (одна позиция за раз), издержки по умолчанию движка.\n`);

// Стрелка, а не `map(walk)`: `map` передаёт вторым и третьим аргументами индекс и массив, то есть
// молча подставил бы их в окно ветки кэша и в смещение старта.
const runs = CADENCES.map((c) => walk(c));

const never = walk(720, H, 0, "never");
console.log(`## З1: итог по кадансам\n`);
console.log(`| каданс | точек решения | входов | перекладок | выходов в кэш | кругов оплачено | брутто | издержки | нетто |`);
console.log(`|---|---|---|---|---|---|---|---|---|`);
console.log(`| БАЗА: вошли и держим | ${never.decisions} | ${never.tally.open} | 0 | 0 | 1 | ${$(never.realized)} | ${$(never.costs)} | ${$(never.net)} |`);
for (const r of runs) {
  const trades = r.tally.open + r.tally.switch;
  console.log(`| ${r.cadence} ч | ${r.decisions} | ${r.tally.open} | ${r.tally.switch} | ${r.tally.cash} | ${trades} | ${$(r.realized)} | ${$(r.costs)} | ${$(r.net)} |`);
}
console.log(`\nБАЗА СРАВНЕНИЯ обязательна: правило выхода имеет смысл, только если бьёт «вошли один раз и`);
console.log(`держим до конца». Без этой строки таблица кадансов сравнивала бы правило само с собой.`);
console.log(`\nБюджет решений прогона 3 (8.39 круга в год у BTC two-B на $2000) это НЕ потолок для этой`);
console.log(`таблицы: бюджет равен кэрри, делённому на долю круга в номинале, поэтому у каждого рынка он`);
console.log(`свой. При брутто ${$(runs[0].realized)} и круге около $16.50 на $${CAPITAL} бюджет тут порядка`);
console.log(`${Math.round(runs[0].realized / 16.5)} кругов в год, и столбец «кругов оплачено» надо сверять с ним.`);

// ── РАЗБРОС ПО СТАРТАМ. Одна траектория за один год это одно наблюдение, и разница кадансов на ней
// может быть чем угодно. Сдвиг момента запуска даёт дешёвый разброс: данные те же, а путь другой.
const STARTS = Number(argOf("--starts", 12));
const STEP = Number(argOf("--start-step", 60));
if (STARTS > 1) {
  console.log(`\n## Разброс по моменту запуска: ${STARTS} стартов с шагом ${STEP} ч\n`);
  // СРЕДНЕЕ СТОИТ РЯДОМ С МЕДИАНОЙ НЕ ДЛЯ ПОЛНОТЫ. Исход БАЗЫ определяется тем, какой рынок поймал
  // первый вход, а лучшая альтернатива меняется реже шага старта, поэтому распределение базы
  // ДВУХТОЧЕЧНОЕ. На двух точках медиана это просто та из них, что выпала чаще, и сдвиг сетки
  // стартов её переворачивает; среднее так не переворачивается. Печатать одну медиану значило бы
  // выдать за разброс исходов результат двенадцати бросков двух монет.
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`| каданс | медиана нетто | СРЕДНЕЕ | мин | макс | кругов, медиана | лучше базы |`);
  console.log(`|---|---|---|---|---|---|---|`);
  // ОБЩИЙ КОНЕЦ у всех прогонов: иначе поздний старт короче раннего, и размах получает добавку от
  // длины, а не от поведения.
  const END = YEAR - (STARTS - 1) * STEP;
  const baseNets = [];
  const firstPicks = new Set();
  const pickLog = [];
  for (let s = 0; s < STARTS; s += 1) {
    const r = walk(720, H, s * STEP, "never", END);
    baseNets.push(r.net);
    const open0 = r.log.find((e) => e.act === "open");
    const pick = open0 ? `${open0.token}/${open0.config}` : "нет";
    firstPicks.add(pick);
    pickLog.push(pick);
  }
  // Разряд здесь ДВА ЗНАКА, а не сокращённые тысячи: разница кадансов измеряется десятками
  // долларов, и «$1.0k против $1.0k» стёрло бы ровно ту величину, ради которой таблица снимается.
  const d2 = (x) => `$${x.toFixed(2)}`;
  console.log(`| БАЗА | ${d2(q(baseNets, 0.5))} | ${d2(mean(baseNets))} | ${d2(Math.min(...baseNets))} | ${d2(Math.max(...baseNets))} | 1 | . |`);
  for (const cad of CADENCES) {
    const nets = [];
    const trips = [];
    let beat = 0;
    for (let s = 0; s < STARTS; s += 1) {
      const r = walk(cad, H, s * STEP, "rule", END);
      nets.push(r.net);
      trips.push(r.tally.open + r.tally.switch);
      if (r.net > baseNets[s]) beat += 1;
    }
    console.log(`| ${cad} ч | ${d2(q(nets, 0.5))} | ${d2(mean(nets))} | ${d2(Math.min(...nets))} | ${d2(Math.max(...nets))} | ${q(trips, 0.5).toFixed(0)} | ${beat} из ${STARTS} |`);
  }
  console.log(`\nВсе прогоны ОДНОЙ ДЛИНЫ (общий конец на часе ${END}), иначе поздний старт был бы короче`);
  console.log(`раннего на ${(STARTS - 1) * STEP} ч и размах получил бы добавку от длины, а не от поведения.`);
  console.log(`\nСтарты ПЕРЕСЕКАЮТСЯ по данным (сдвиг ${STEP} ч при годе в ${YEAR}), поэтому это разброс`);
  console.log(`траектории, а НЕ независимая выборка, и доверительного интервала из него не выводится.`);
  // СКОЛЬКО ЗДЕСЬ НА САМОМ ДЕЛЕ НАБЛЮДЕНИЙ. Исход базы определяется тем, какой рынок поймал ПЕРВЫЙ
  // вход, а лучшая альтернатива меняется реже, чем шаг старта. Если разных первых рынков мало, то
  // мин, медиана и макс базы это несколько чисел с кратностями, а не ${STARTS} наблюдений, и
  // таблица обещала бы статистику, которой нет.
  console.log(`\nРАЗНЫХ ПЕРВЫХ РЫНКОВ У БАЗЫ: ${firstPicks.size} (${[...firstPicks].join(", ")}).`);
  console.log(`Поимённо по стартам: ${pickLog.map((p, i) => `${i}:${p}`).join(" ")}`);
  if (firstPicks.size < STARTS) {
    console.log(`Это значит, что ${STARTS} базовых прогонов дают ${firstPicks.size} РАЗЛИЧНЫХ исходов с кратностями,`);
    console.log(`а не ${STARTS} наблюдений. Строку «лучше базы N из ${STARTS}» читать соответственно.`);
  }
}

console.log(`\n## З2: достижимость веток\n`);
console.log(`| каданс | держать | в кэш | переложить | простой (позиции нет) |`);
console.log(`|---|---|---|---|---|`);
for (const r of runs) console.log(`| ${r.cadence} ч | ${r.tally.hold} | ${r.tally.cash} | ${r.tally.switch} | ${r.tally.idle} |`);

console.log(`\n## Перекладки в ТОТ ЖЕ рынок\n`);
console.log(`| каданс | перекладок всего | в тот же рынок | из них та же сторона (смена размера) | из них смена стороны |`);
console.log(`|---|---|---|---|---|`);
for (const r of runs) console.log(`| ${r.cadence} ч | ${r.tally.switch} | ${r.tally.sameToken} | ${r.tally.sameTokenSameConfig} | ${r.tally.configFlip} |`);
console.log(`\nСмена стороны A/B по измеренному критерию прогона 3 круг НЕ окупает, поэтому ненулевой`);
console.log(`последний столбец это сигнал разбираться, а не свойство.`);

// Перекладка в тот же рынок с той же стороной это ЧИСТАЯ СМЕНА РАЗМЕРА, и её надо показать
// поимённо: при равном размере она невозможна арифметически (нетто равно брутто минус круг), значит
// каждая такая строка обязана содержать РАЗНЫЕ размеры, и это проверяется глазом, а не верой.
{
  const same = runs[0].log.filter((e) => e.act === "switch" && e.from && e.from.startsWith(`${e.token}/${e.config}/`));
  console.log(`\nЧистые смены размера при кадансе ${runs[0].cadence} ч, первые 10 из ${same.length}:\n`);
  for (const e of same.slice(0, 10)) {
    console.log(`  ${iso(rowsOf.get(e.token)[e.t].tsHour)}  ${e.from} в $${e.size}: брутто ${$(e.hold)} против нетто ${$(e.net)}`);
  }
  const equal = same.filter((e) => e.from === `${e.token}/${e.config}/${e.size}`);
  console.log(`\nстрок с ОДИНАКОВЫМ размером: ${equal.length} (обязано быть 0: при равном размере нетто = брутто минус круг)`);
}

console.log(`\n## З3 на РАБОЧЕМ наборе: решение против того, что случилось\n`);
console.log(`Отличие от общего замера З3 в том, что здесь учтены только те часы, когда правило`);
console.log(`ДЕЙСТВИТЕЛЬНО держало позицию, отобранную правилом входа.\n`);
console.log(`ДВЕ РАЗНЫЕ МЕТРИКИ, И СЛИВАТЬ ИХ НЕЛЬЗЯ. Перекладка НЕ утверждает, что удержание убыточно,`);
console.log(`она утверждает, что альтернатива лучше. Поэтому качество веток меряется врозь:`);
console.log(`удержание сверяется со знаком того, что случилось; перекладка сверяется КОНТРФАКТИЧЕСКИ,`);
console.log(`то есть реализованным брутто новой позиции против брутто старой на том же отрезке.\n`);
// ПЕРЕКЛАДКИ РАЗЛОЖЕНЫ НА ДВА КЛАССА, и смешивать их нельзя. Смена размера в ТОМ ЖЕ рынке это
// храповик, отдельно показанный как жгущий деньги; межрыночная перекладка это утверждение про
// ВЫБОР РЫНКА, ради которого правило и существует. В смешанной популяции при кадансе 1 ч больше
// половины строк храповиковые, и общая доля «окупились» тогда описывает в основном его арифметику.
console.log(`| каданс | решений с позицией | держали, а вперёд минус | межрыночных | окупились | медиана | храповиковых | окупились | медиана |`);
console.log(`|---|---|---|---|---|---|---|---|---|`);
const share = (a) => (a.length ? `${a.filter((g) => g > 0).length} (${((a.filter((g) => g > 0).length / a.length) * 100).toFixed(0)}%)` : "н-д");
for (const r of runs) {
  const n = r.probes.length;
  if (!n) { console.log(`| ${r.cadence} ч | 0 | н-д | н-д | н-д | н-д | н-д | н-д | н-д |`); continue; }
  const held = r.probes.filter((p) => p.act === "hold");
  const heldBad = held.filter((p) => p.fwd < 0).length;
  const sw = r.probes.filter((p) => p.act === "switch");
  const gainOf = (a) => a.map((p) => p.fwdNew - p.fwd - p.cost);
  const cross = gainOf(sw.filter((p) => !p.same));
  const ratchet = gainOf(sw.filter((p) => p.same));
  console.log(`| ${r.cadence} ч | ${n} | ${held.length ? ((heldBad / held.length) * 100).toFixed(1) : "н-д"}% `
    + `| ${cross.length} | ${share(cross)} | ${cross.length ? $(q(cross, 0.5)) : "н-д"} `
    + `| ${ratchet.length} | ${share(ratchet)} | ${ratchet.length ? $(q(ratchet, 0.5)) : "н-д"} |`);
}

// ── ПАРНОЕ СРАВНЕНИЕ С БАЗОЙ. Считается РАЗНОСТЬ рук НА ОДНОМ старте, а не две статистики порознь,
// и разница между этими двумя способами оказалась решающей.
//
// ПОЧЕМУ ПОРОЗНЬ НЕЛЬЗЯ. Исход БАЗЫ определяется тем, какой рынок поймал первый вход, и различных
// первых рынков на всей сетке стартов единицы. Значит распределение базы состоит из нескольких
// точек с кратностями, и любая его статистика мешает эффект РУКИ с эффектом того, ЧТО ВЫПАЛО.
// Парная разность снимает второе целиком: обе руки стартуют в один час, видят одни данные и
// получают один и тот же первый рынок, поэтому в разности он сокращается.
//
// Знак вывода от этого перехода МЕНЯЕТСЯ, и это не тонкость подачи: по распределениям правило
// выглядит победителем (среднее выше), по разностям оно проигрывает в большинстве стартов.
const PAIRED = Number(argOf("--paired", 0));
const PAIRED_STEP = Number(argOf("--paired-step", 12));
if (PAIRED > 1) {
  // КОНЕЦ ФИКСИРУЕТСЯ ЯВНО, а не выводится из числа стартов. Иначе сравнение РАЗНЫХ сеток стартов
  // мешало бы смену сетки со сменой длины прогона: при 30 стартах конец был бы на часе 8413, при
  // 80 на 7813, и «неустойчивость к сетке» частично оказалась бы неустойчивостью к длине.
  const END2 = Number(argOf("--paired-end", YEAR - (PAIRED - 1) * PAIRED_STEP));
  const CAD = Number(argOf("--paired-cadence", 24));
  const diffs = [];
  const picks = new Map();
  let ruleWins = 0;
  for (let i = 0; i < PAIRED; i += 1) {
    const off = i * PAIRED_STEP;
    const base = walk(720, H, off, "never", END2);
    const rule = walk(CAD, H, off, "rule", END2);
    const open0 = base.log.find((e) => e.act === "open");
    const pick = open0 ? `${open0.token}/${open0.config}` : "нет";
    picks.set(pick, (picks.get(pick) || 0) + 1);
    // Обе руки обязаны стартовать в ОДНОМ рынке, иначе разность сравнивала бы не руки.
    const rOpen = rule.log.find((e) => e.act === "open");
    const same = rOpen && open0 && rOpen.token === open0.token && rOpen.config === open0.config;
    diffs.push({ off, d: rule.net - base.net, pick, same });
    if (rule.net > base.net) ruleWins += 1;
  }
  const d = diffs.map((x) => x.d);
  const mean2 = d.reduce((a, b) => a + b, 0) / d.length;
  console.log(`\n## Парное сравнение с базой: ${PAIRED} стартов со сдвигом ${PAIRED_STEP} ч, каданс ${CAD} ч\n`);
  console.log(`Разность нетто рук НА ОДНОМ старте (общий конец на часе ${END2}).\n`);
  console.log(`| величина | значение |`);
  console.log(`|---|---|`);
  console.log(`| правило выигрывает | ${ruleWins} из ${PAIRED} |`);
  console.log(`| медиана разности | $${q(d, 0.5).toFixed(2)} |`);
  console.log(`| среднее разности | $${mean2.toFixed(2)} |`);
  console.log(`| p10 | $${q(d, 0.1).toFixed(2)} |`);
  console.log(`| p90 | $${q(d, 0.9).toFixed(2)} |`);
  console.log(`| стартов, где руки вошли в РАЗНЫЕ рынки | ${diffs.filter((x) => !x.same).length} |`);
  console.log(`\nПервые рынки базы: ${[...picks].map(([k, v]) => `${v}x ${k}`).join(", ")}.`);
  console.log(`Различных рынков ${picks.size} на ${PAIRED} стартов, поэтому статистики РАСПРЕДЕЛЕНИЯ здесь`);
  console.log(`нет и брать её нельзя; парная разность от этого не страдает, потому что рынок в ней общий.`);
}

// ── З4 в деньгах: та же развёртка окна ветки кэша, но итог считается кругами и долларами, а не
// долями верных выходов. Каданс фиксирован, чтобы мерилась ОДНА правка.
const CASH_WINDOWS = String(argOf("--cash-windows", "72,168,336,720")).split(",").map(Number);
const FIXED_CADENCE = Number(argOf("--cash-cadence", "24"));
console.log(`\n## З4 в деньгах: окно ветки кэша при кадансе ${FIXED_CADENCE} ч\n`);
console.log(`| окно кэша | входов | перекладок | выходов в кэш | кругов | брутто | издержки | нетто |`);
console.log(`|---|---|---|---|---|---|---|---|`);
for (const w of CASH_WINDOWS) {
  const r = walk(FIXED_CADENCE, w);
  const trades = r.tally.open + r.tally.switch;
  console.log(`| ${w} ч | ${r.tally.open} | ${r.tally.switch} | ${r.tally.cash} | ${trades} | ${$(r.realized)} | ${$(r.costs)} | ${$(r.net)} |`);
}
console.log(`\nЗамер З4 по долям дал: короткое окно поднимает полноту, но роняет точность и`);
console.log(`своевременность. Здесь тот же вопрос задан деньгами, и деньги старше долей.`);

console.log(`\n## Журнал решений при кадансе ${runs[0].cadence} ч, первые 40 действий\n`);
for (const e of runs[0].log.slice(0, 40)) {
  if (e.act === "open") console.log(`  ${iso(rowsOf.get(e.token)[e.t].tsHour)}  ВХОД      ${e.token}/${e.config} $${e.size} нетто ${$(e.net)}`);
  else if (e.act === "cash") console.log(`  ${iso(rowsOf.get(e.token)[e.t].tsHour)}  В КЭШ     ${e.token} брутто ${$(e.hold)}`);
  else console.log(`  ${iso(rowsOf.get(e.token)[e.t].tsHour)}  ПЕРЕЛОЖИТЬ ${e.from} в ${e.token}/${e.config} $${e.size}: брутто ${$(e.hold)} против нетто ${$(e.net)}`);
}

console.log(`\n## Границы\n`);
console.log(`- ОДНА позиция за раз: правило выхода фазы 3 решает по одной сделке, портфель это фаза 4;`);
console.log(`- ёмкость и кривые удара это СНИМОК 2026-08-30 против окон 2025-06..2026-06;`);
console.log(`- доходность отсюда НЕ следует: это один год, одна вселенная и один потолок тикета.`);
