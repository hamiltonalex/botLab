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
// ГРАНИЦЫ - в конце отчёта, и читать их обязательно: прогон по фикстурам не проверяет живую ветку
// начисления, снабжение сетью и вообще ничего про исполнение.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpreadCsv } from "../src/engine/format.js";
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
  --tokens <A,B,C>      какие инструменты гонять (по умолчанию APT,BTC,ETH)
  --capital <$>         капитал позиции (по умолчанию 2000, как в golden.test.js)
  --leverage <x>        плечо (по умолчанию 1)
  --book <файл>         записать книгу (TSV, посуточные строки по каждой позиции)
  --drop-rule <имя>     КОНТРОЛЬ: заглушить одно правило и убедиться, что книга это заметит.
                        cost-off    - издержки круга обнулены;
                        config-flip - держится конфигурация, которую scanTwoLeg НЕ выбрал;
                        hl-off      - двуногие позиции ведутся как однуногие (ноги HL нет);
                        rows-half   - леджеру достаётся каждая вторая строка истории`);
  process.exit(0);
}

const FIXTURES = resolve(APP, argOf("--fixtures", "test/fixtures"));
const TOKENS = String(argOf("--tokens", "APT,BTC,ETH")).split(",").map((s) => s.trim()).filter(Boolean);
const CAPITAL = Number(argOf("--capital", "2000"));
const LEVERAGE = Number(argOf("--leverage", "1"));
const BOOK = argOf("--book");
const DROP = argOf("--drop-rule");
const DROPS = ["cost-off", "config-flip", "hl-off", "rows-half"];
if (DROP != null && !DROPS.includes(DROP)) {
  console.error(`--drop-rule: ${DROPS.join(" | ")}, получено «${DROP}»`); process.exit(1);
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

const notional = CAPITAL * LEVERAGE;
const positions = [];
const bookRows = [];
const chosenBy = new Map();

for (const token of TOKENS) {
  const rows = frames.get(token);
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
      roundTripCost: cost, meta: { token, variant: v.key },
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
      if (!acc) { acc = { hours: 0, funding: 0, borrow: 0, hl: 0, d: 0, skipped: 0, cum: 0, t: a.t }; byDay.set(d, acc); }
      acc.hours += 1;
      acc.funding += a.fundingUsd ?? 0;
      acc.borrow += a.borrowUsd ?? 0;
      acc.hl += a.dPnlHl ?? 0;
      acc.d += a.dPnl ?? 0;
      acc.skipped += a.gapSkippedSec ?? 0;
      acc.cum = a.cum; // накопленное на конец последнего начисления дня
      acc.t = a.t;
    }
    for (const [day, acc] of byDay) {
      bookRows.push([
        bookRows.length + 1, token, v.key, config ?? "-", day, acc.hours,
        f6(acc.funding), f6(acc.borrow), f6(acc.hl), f6(acc.d), f6(acc.cum),
        f6(CAPITAL + acc.cum - p.roundTripCost), f6(p.maxDrawdown), f2(acc.skipped),
      ]);
    }
  }
}

const HEAD = ["#", "инструмент", "схема", "конфиг", "день", "часов", "фандинг", "борроу",
  "HL", "за день", "накоплено", "equityNet", "просадка", "пропущено"];
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
if (DROP) console.log(`\nКОНТРОЛЬ: заглушено правило «${DROP}». Книга ОБЯЗАНА разойтись с эталонной.`);

console.log(`\n## Позиции\n`);
console.log(`| инструмент | схема | часов | пропущено с | брутто $ | нетто $ | доходность | APR | просадка $ |`);
console.log(`|---|---|---|---|---|---|---|---|---|`);
for (const p of positions) {
  const s = positionSummary(p);
  const mark = p.strategy === "two" && p.config === chosenBy.get(p.instrumentKey) ? " *" : "";
  console.log(`| ${p.instrumentKey} | ${p.meta.variant}${mark} | ${p.meta.applied.hoursApplied} | `
    + `${p.meta.applied.gapSkippedSec.toFixed(0)} | ${f2(s.grossPnl)} | ${f2(s.netPnl)} | `
    + `${(s.ret * 100).toFixed(2)}% | ${Number.isFinite(s.apr) ? `${(s.apr * 100).toFixed(2)}%` : "н-д"} | ${f2(p.maxDrawdown)} |`);
}
console.log(`\n\\* конфигурация, которую выбрал бы сканер бота 1 на этих данных.`);

const acc = accountSummary(positions);
console.log(`\n## Счёт целиком\n`);
console.log(`позиций ${acc.count}; капитал $${acc.capitalAll}; брутто $${f2(acc.grossPnl)}; нетто $${f2(acc.netPnl)};`);
console.log(`доходность ${(acc.ret * 100).toFixed(2)}%; APR ${(acc.apr * 100).toFixed(2)}%; общая просадка $${f2(acc.maxDrawdown)};`);
console.log(`не оценённого времени ${acc.gapSkippedSec.toFixed(0)} с.`);
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
