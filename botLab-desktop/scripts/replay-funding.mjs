#!/usr/bin/env node
// replay-funding.mjs - ПРОГОН ИСТОРИИ ЧЕРЕЗ ЖИВОЙ ЛЕДЖЕР БОТА 1 (фандинг-арбитраж). READ-ONLY.
//
// ЗАЧЕМ, И ЧЕГО У БОТА 1 НЕ БЫЛО. Охрана бота 1 состояла из `test/golden.test.js`: три годовые
// CSV-фикстуры прогоняются через АНАЛИТИКУ (`math.js`) и сверяются с числами аудита питоновского
// движка. Это проверяет, что порт формул считает те же проценты. Оно НЕ проверяет второй слой -
// БУМАЖНЫЙ ЛЕДЖЕР (`paper.js`), тот самый, который и есть «результат бота»: начисление по часам,
// дискретные расчёты HL на границе часа, издержки круга, просадка, сводка счёта. У леджера были
// только юнит-тесты на отдельные шаги и НИ ОДНОЙ сквозной сверки за год.
//
// ЗДЕСЬ ЛЕДЖЕР ВЕДЁТ ПОЗИЦИЮ САМ. Подменены ТОЛЬКО снабжение и часы - ровно как в прогоне бота 2:
//   источник рынка - часовые строки фикстуры вместо REST-опроса GMX и Hyperliquid;
//   часы           - метка строки вместо Date.now.
// Дальше зовутся настоящие входные точки и ничего кроме них:
//   parseSpreadCsv   - разбор кэша ставок (format.js), тот же, которым живёт приложение;
//   scanTwoLeg       - ВЫБОР КОНФИГУРАЦИИ A/B (math.js): какую сторону вообще держать;
//   roundTripCost    - издержки круга (costs.js) с дефолтной моделью;
//   openPosition     - открытие позиции (paper.js);
//   accrueFromRows   - начисление по историческим строкам: GMX непрерывно по секундам, HL одним
//                      расчётом на каждую пересечённую границу часа;
//   positionSummary / accountSummary - итог позиции и счёта.
// Если бы для прогона пришлось повторить хоть одно из этих решений, это была бы не сверка, а ВТОРАЯ
// реализация правил, и доказывала бы она только сама себя. Проверка на это встроена: `--drop-rule`
// глушит одно правило и ОБЯЗАН сломать книгу.
//
// ЧТО ПРОГОН ПОКАЗАЛ СРАЗУ (2026-08-29, первый запуск): книга леджера сходится с эталонными числами
// аудита ДО ЦЕНТА - APT конфигурация A даёт $1067.9539 против golden +$1067.95, BTC B $60.4286
// против +$60.43, ETH A $59.3568 против +$59.36. То есть два слоя бота 1, аналитический и
// леджерный, считают одно и то же на одних данных. Раньше это не проверял никто.
//
// ДВА РЕЖИМА, И ЭТО ДВЕ РАЗНЫЕ КНИГИ. Без `--bases` леджер начисляет по КОТИРУЕМОЙ ставке: так он
// считал до появления правила разбавления, и эта книга стережёт, что правка ничего не сдвинула там,
// где сдвигать не собиралась. С `--bases` тот же леджер эмулирует РЕАЛЬНЫЙ вход: котируемая ставка
// умножается на `B/(B+S)` по базе фандинга нашей стороны в этот час (`fa/dilution.js`). Разница
// между книгами и есть измеренная цена фантома, из-за которого четыре прогона исследования подряд
// считали несуществующую прибыль.
//
// ГРАНИЦЫ - в конце отчёта, и читать их обязательно: прогон по фикстурам не проверяет живую ветку
// начисления, снабжение сетью и вообще ничего про исполнение.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpreadCsv } from "../src/engine/format.js";
import { baseUsd, potOf } from "../src/engine/fa/dilution.js";
import { scanTwoLeg, scanOneLeg } from "../src/engine/math.js";
import { DEFAULT_COSTS, roundTripCost } from "../src/engine/costs.js";
import {
  openPosition, accrueFromRows, closePosition, positionSummary, accountSummary,
} from "../src/engine/paper.js";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

if (args.includes("--help")) {
  console.log(`replay-funding.mjs - прогон годовых фикстур через бумажный леджер бота 1

  --fixtures <каталог>  каталог с CSV кэша ставок (по умолчанию test/fixtures)
  --bases <каталог>     почасовые базы фандинга GMX (<токен>.json[.gz]); включает разбавление входа
  --tokens <A,B,C>      какие инструменты гонять (по умолчанию APT,BTC,ETH)
  --capital <$>         капитал позиции (по умолчанию 2000, как в golden.test.js)
  --leverage <x>        плечо (по умолчанию 1)
  --book <файл>         записать книгу (TSV, посуточные строки по каждой позиции)
  --drop-rule <имя>     КОНТРОЛЬ: заглушить одно правило и убедиться, что книга это заметит.
                        cost-off    - издержки круга обнулены;
                        config-flip - держится конфигурация, которую scanTwoLeg НЕ выбрал;
                        hl-off      - двуногие позиции ведутся как однуногие (ноги HL нет);
                        rows-half   - леджеру достаётся каждая вторая строка истории;
                        только с --bases:
                        dilution-off   - разбавление выключено (книга возвращается к фантому);
                        dilution-wrong - подставлен опровергнутый множитель S/(B+S)`);
  process.exit(0);
}

const FIXTURES = resolve(APP, argOf("--fixtures", "test/fixtures"));
const BASES_ARG = argOf("--bases");
const BASES = BASES_ARG == null ? null : resolve(APP, BASES_ARG);
const TOKENS = String(argOf("--tokens", "APT,BTC,ETH")).split(",").map((s) => s.trim()).filter(Boolean);
const CAPITAL = Number(argOf("--capital", "2000"));
const LEVERAGE = Number(argOf("--leverage", "1"));
const BOOK = argOf("--book");
const DROP = argOf("--drop-rule");
const DROPS = ["cost-off", "config-flip", "hl-off", "rows-half"];
const DIL_DROPS = ["dilution-off", "dilution-wrong"];
if (DROP != null && !DROPS.includes(DROP) && !DIL_DROPS.includes(DROP)) {
  console.error(`--drop-rule: ${[...DROPS, ...DIL_DROPS].join(" | ")}, получено «${DROP}»`); process.exit(1);
}
// Контроль разбавления без баз заглушил бы правило, которого в прогоне нет вовсе, и книга сошлась
// бы с эталонной. Проверка, которая не может упасть, не проверка, поэтому это ошибка вызова.
if (DIL_DROPS.includes(DROP) && !BASES) {
  console.error(`--drop-rule ${DROP} требует --bases: без баз разбавления в прогоне нет`); process.exit(1);
}
if (!(CAPITAL > 0) || !(LEVERAGE > 0)) { console.error("--capital и --leverage: положительные числа"); process.exit(1); }

const HOUR_MS = 3600000;
const f6 = (x) => (Number.isFinite(x) ? x.toFixed(6) : "н-д");
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "н-д");
// День, которому принадлежит начисление. Метка начисления это КОНЕЦ часа, поэтому час 23:00-00:00
// обязан лечь в день, содержащий 23:00, а не в следующий: минус миллисекунда, и граница читается
// так же, как её читает человек.
const dayOf = (t) => new Date(t - 1).toISOString().slice(0, 10);

// ── Фикстуры. Каталог, а не сеть: годовые CSV кэша ставок лежат в репозитории и являются тем же
// сырьём, на котором стоит golden.test.js. Отсутствие файла называется адресом, а не стектрейсом.
let available;
try { available = readdirSync(FIXTURES); }
catch { console.error(`нет каталога фикстур: ${FIXTURES}`); process.exit(1); }
const frames = new Map();
for (const token of TOKENS) {
  const name = `${token}.csv`;
  if (!available.includes(name)) {
    console.error(`нет фикстуры ${name} в ${FIXTURES} (есть: ${available.filter((f) => f.endsWith(".csv")).join(", ") || "ни одной"})`);
    process.exit(1);
  }
  const rows = parseSpreadCsv(readFileSync(join(FIXTURES, name), "utf8"));
  if (!rows.length) { console.error(`фикстура ${name} пуста`); process.exit(1); }
  frames.set(token, rows);
}

// ── Базы фандинга. Тот же каталог, что читало исследование: почасовые снимки
// `fundingBalanceOiSnapshots` первоисточника, поля в неподвижной точке 1e30. Строки фикстуры и
// снимки выровнены по tsHour, а не по порядку: пропуск часа в одном из рядов иначе сдвинул бы
// весь остаток года на час и дал бы правдоподобную неверную книгу.
const notional = CAPITAL * LEVERAGE;
const identity = { hours: 0, bad: 0, errs: [] };
function loadBases(token) {
  const gz = join(BASES, `${token}.json.gz`);
  const plain = join(BASES, `${token}.json`);
  let text;
  try { text = gunzipSync(readFileSync(gz)).toString("utf8"); }
  catch {
    try { text = readFileSync(plain, "utf8"); }
    catch { console.error(`нет баз для ${token}: ни ${gz}, ни ${plain}`); process.exit(1); }
  }
  const m = new Map();
  for (const r of JSON.parse(text).oi || []) {
    m.set(Number(r.snapshotTimestamp), { L: baseUsd(r.longFundingBalanceOiUsd), S: baseUsd(r.shortFundingBalanceOiUsd) });
  }
  if (!m.size) { console.error(`базы ${token} пусты`); process.exit(1); }
  return m;
}
// Контроль `dilution-wrong` подставляет базу S*S/B. Это НЕ вторая реализация правила: множитель
// B/(B+S) от такой базы равен ровно S/(B+S), то есть опровергнутой форме, и контроль меняет ВХОД
// леджера, а не его код, как и все остальные контроли этого прогона. Нулевая база даёт
// бесконечность и множитель 1, что тоже совпадает с опровергнутой формой (S/(0+S) = 1) - именно
// этим она и сохраняла фантазию рынков с крошечной базой.
const wrongBase = (b) => (b > 0 ? (notional * notional) / b : Infinity);
function withBases(token, rows) {
  if (!BASES) return rows;
  const m = loadBases(token);
  return rows.map((r) => {
    const o = m.get(r.tsHour);
    if (!o) return r; // база на этот час не пришла: леджер обнулит доход и назовёт причину no_base
    const id = potOf(r.f_long, o.L, r.f_short, o.S);
    if (Number.isFinite(id.relErr)) { identity.hours += 1; identity.errs.push(id.relErr); if (!id.ok) identity.bad += 1; }
    return DROP === "dilution-wrong"
      ? { ...r, fbase_long: wrongBase(o.L), fbase_short: wrongBase(o.S) }
      : { ...r, fbase_long: o.L, fbase_short: o.S };
  });
}
const DILUTE = !!BASES && DROP !== "dilution-off";

// ── Матрица позиций. ТРИ ВАРИАНТА НА ИНСТРУМЕНТ, и это не щедрость: `legModel` (paper.js) ветвится
// по стороне GMX и по знаку расчёта HL, и книга обязана держать под охраной ВСЕ его ветки.
// Конфигурация A это шорт GMX плюс лонг HL, B это лонг GMX плюс шорт HL, однуногая обходится без
// HL вовсе (hlPerHourSign = 0). Одна лишь выбранная сканером конфигурация оставила бы половину
// матрицы без охраны: для APT и ETH сканер выбирает A, для BTC - B, и противоположная ветка каждого
// не исполнялась бы никогда.
const VARIANTS = [
  { key: "two-A", strategy: "two", config: "A" },
  { key: "two-B", strategy: "two", config: "B" },
  { key: "one", strategy: "one", config: null },
];

const positions = [];
const bookRows = [];
const chosenBy = new Map();

for (const token of TOKENS) {
  const rows = withBases(token, frames.get(token));
  // Выбор конфигурации делает ПРАВИЛО (`scanTwoLeg`), а не прогон: какую сторону держать - решение
  // стратегии, и повторить его здесь значило бы завести вторую реализацию того же выбора.
  const scan = scanTwoLeg(rows, { token });
  chosenBy.set(token, scan.chosen);
  const fed = DROP === "rows-half" ? rows.filter((_, i) => i % 2 === 0) : rows;
  const t0 = rows[0].tsHour * 1000;
  const tEnd = rows[rows.length - 1].tsHour * 1000 + HOUR_MS;

  for (const v of VARIANTS) {
    // Контроли меняют ВХОД леджера, а не его код: заглушить правило можно только тем же способом,
    // каким его настраивает приложение, иначе контроль проверял бы правку прогона.
    let strategy = v.strategy;
    let config = v.config;
    if (DROP === "hl-off" && strategy === "two") strategy = "one", config = null;
    if (DROP === "config-flip" && v.strategy === "two") config = v.config === "A" ? "B" : "A";
    const isOneLeg = strategy === "one";
    const cost = DROP === "cost-off" ? 0 : roundTripCost(DEFAULT_COSTS, notional, isOneLeg);

    const p = openPosition({
      strategy, instrumentKey: token, config,
      capital: CAPITAL, leverage: LEVERAGE, nowMs: t0,
      roundTripCost: cost, dilute: DILUTE, meta: { token, variant: v.key },
    });
    const applied = accrueFromRows(p, fed, tEnd);
    closePosition(p, tEnd);
    p.meta.applied = applied;
    p.meta.variant = v.key;
    positions.push(p);

    // ── Посуточные строки книги. Здесь только СУММИРОВАНИЕ того, что леджер уже записал в свой
    // журнал начислений: ни одна величина тут не вычисляется заново. Разряд шесть знаков, а не два:
    // на $2000 номинала дневной поток BTC составляет около $0.16, и центы стёрли бы разницу, ради
    // которой книга и снимается. Порядок сложения тот же, что у журнала (он и есть порядок леджера).
    const byDay = new Map();
    for (const a of p.accruals) {
      const d = dayOf(a.t);
      let acc = byDay.get(d);
      if (!acc) { acc = { hours: 0, funding: 0, borrow: 0, hl: 0, d: 0, skipped: 0, cum: 0, t: a.t, quoted: 0, mul: 0, mulN: 0, noBase: 0 }; byDay.set(d, acc); }
      acc.hours += 1;
      acc.funding += a.fundingUsd ?? 0;
      acc.borrow += a.borrowUsd ?? 0;
      acc.hl += a.dPnlHl ?? 0;
      acc.d += a.dPnl ?? 0;
      acc.skipped += a.gapSkippedSec ?? 0;
      acc.cum = a.cum; // накопленное на конец последнего начисления дня
      acc.t = a.t;
      // Столбцы разбавления. Множитель усредняется ТОЛЬКО по часам, где он вообще применялся:
      // подмешать сюда часы «платим мы» с их множителем 1 значило бы напечатать день удержания
      // тем ближе к единице, чем больше мы в этот день платили сами.
      acc.quoted += a.fundingQuotedUsd ?? 0;
      if (a.dilutionReason === "diluted") { acc.mul += a.dilutionFactor; acc.mulN += 1; }
      if (a.dilutionReason === "no_base") acc.noBase += 1;
    }
    for (const [day, acc] of byDay) {
      bookRows.push([
        bookRows.length + 1, token, v.key, config ?? "-", day, acc.hours,
        f6(acc.funding), f6(acc.borrow), f6(acc.hl), f6(acc.d), f6(acc.cum),
        f6(CAPITAL + acc.cum - p.roundTripCost), f6(p.maxDrawdown), f2(acc.skipped),
        // Столбцы разбавления добавляются ТОЛЬКО в режиме разбавления. Дописать их в книгу без
        // баз значило бы сломать её сумму, не сдвинув ни одного правила, а эта книга существует
        // ровно для того, чтобы поймать сдвиг правила и ничего кроме.
        ...(DILUTE ? [f6(acc.quoted), acc.mulN ? f6(acc.mul / acc.mulN) : "н-д", acc.noBase] : []),
      ]);
    }
  }
}

const HEAD = ["#", "инструмент", "схема", "конфиг", "день", "часов", "фандинг", "борроу",
  "HL", "за день", "накоплено", "equityNet", "просадка", "пропущено",
  ...(DILUTE ? ["фандинг котир.", "множитель", "без базы"] : [])];
if (BOOK) {
  writeFileSync(BOOK, `${[HEAD.join("\t"), ...bookRows.map((r) => r.join("\t"))].join("\n")}\n`);
}

// ── Отчёт.
console.log(`# Прогон бота 1 по годовым фикстурам\n`);
console.log(`Фикстуры ${FIXTURES}; инструменты ${TOKENS.join(", ")}; капитал $${CAPITAL} x${LEVERAGE}.`);
for (const token of TOKENS) {
  const rows = frames.get(token);
  console.log(`  ${token}: ${rows.length} часовых строк, ${rows[0].ts} .. ${rows[rows.length - 1].ts}` +
    `; scanTwoLeg выбрал ${chosenBy.get(token)}`);
}
if (BASES) {
  // Тождество |f_long|*B_long == |f_short|*B_short это ЕДИНСТВЕННОЕ, чем можно проверить, что базы
  // те самые: подставь соседнее поле с похожим именем, и невязка перестанет быть шумом плавающей
  // точки. Ожидание по годовой выборке 245 308 часов: медиана 1.3e-14%, p99 4.3e-14%.
  const e = identity.errs.slice().sort((a, b) => a - b);
  const q = (f) => (e.length ? e[Math.min(e.length - 1, Math.floor(e.length * f))] : NaN);
  console.log(`\nБазы фандинга ${BASES}: сверено ${identity.hours} часов, невязка тождества `
    + `медиана ${(q(0.5) * 100).toExponential(2)}%, p99 ${(q(0.99) * 100).toExponential(2)}%, `
    + `не сошлось ${identity.bad}.`);
  console.log(`Разбавление входа ${DILUTE ? "ВКЛЮЧЕНО" : "выключено контролем"}: размер $${notional} на ногу.`);
}
if (DROP) console.log(`\nКОНТРОЛЬ: заглушено правило «${DROP}». Книга ОБЯЗАНА разойтись с эталонной.`);

console.log(`\n## Позиции\n`);
const dilHead = DILUTE ? ` поток котир. $ | удержано |` : "";
const dilBar = DILUTE ? "---|---|" : "";
console.log(`| инструмент | схема | часов | пропущено с | брутто $ | нетто $ | доходность | APR | просадка $ |${dilHead}`);
console.log(`|---|---|---|---|---|---|---|---|---|${dilBar}`);
for (const p of positions) {
  const s = positionSummary(p);
  const mark = p.strategy === "two" && p.config === chosenBy.get(p.instrumentKey) ? " *" : "";
  const dilCells = DILUTE
    ? ` ${f2(s.flowQuoted)} | ${s.dilutionRetained == null ? "н-д" : `${(s.dilutionRetained * 100).toFixed(1)}%`} |`
    : "";
  console.log(`| ${p.instrumentKey} | ${p.meta.variant}${mark} | ${p.meta.applied.hoursApplied} | `
    + `${p.meta.applied.gapSkippedSec.toFixed(0)} | ${f2(s.grossPnl)} | ${f2(s.netPnl)} | `
    + `${(s.ret * 100).toFixed(2)}% | ${Number.isFinite(s.apr) ? `${(s.apr * 100).toFixed(2)}%` : "н-д"} | ${f2(p.maxDrawdown)} |${dilCells}`);
}
console.log(`\n\\* конфигурация, которую выбрал бы сканер бота 1 на этих данных.`);

const acc = accountSummary(positions);
console.log(`\n## Счёт целиком\n`);
console.log(`позиций ${acc.count}; капитал $${acc.capitalAll}; брутто $${f2(acc.grossPnl)}; нетто $${f2(acc.netPnl)};`);
console.log(`доходность ${(acc.ret * 100).toFixed(2)}%; APR ${(acc.apr * 100).toFixed(2)}%; общая просадка $${f2(acc.maxDrawdown)};`);
console.log(`не оценённого времени ${acc.gapSkippedSec.toFixed(0)} с.`);
if (DILUTE) {
  // Цена фантома одной строкой. Котируемый фандинг это то, что леджер начислял себе ДО правки;
  // разница с полученным и есть прибыль, которой не существует.
  console.log(`поток котируемый $${f2(acc.flowQuoted)}; полученный $${f2(acc.flowReceived)}; `
    + `удержано ${acc.dilutionRetained == null ? "н-д" : `${(acc.dilutionRetained * 100).toFixed(1)}%`}; `
    + `часов без базы ${(acc.noBaseSec / 3600).toFixed(0)}.`);
}
console.log(`\nКнига: ${bookRows.length} посуточных строк${BOOK ? ` записана в ${BOOK}` : " (не записана: нет --book)"}.`);

console.log(`\n## Границы: чего этот прогон НЕ проверяет\n`);
console.log(`- ЖИВУЮ ветку начисления (accrue по мгновенному снимку, потолок maxDtSec, учёт`);
console.log(`  gapSkippedSec): здесь исполняется историческая ветка accrueFromRows, и это разные пути;`);
console.log(`- снабжение: sources.js и backfill.js (сеть, слияние кэша со свежим хвостом) не заходят сюда`);
console.log(`  вовсе, поэтому дефект склейки окна этой книгой не ловится;`);
console.log(`- исполнение: бот 1 не моделирует ни проскальзывание, ни ликвидацию, ни отказ исполнения -`);
console.log(`  его P&L это ЧИСТЫЙ КЭРРИ за вычетом смоделированного круга издержек, и книга наследует`);
console.log(`  ровно это допущение (шапка paper.js);`);
console.log(`- независимость данных: фикстуры те же, на которых стоит golden.test.js. Книга добавляет`);
console.log(`  независимый СЛОЙ (леджер против аналитики), а не независимую выборку.`);
