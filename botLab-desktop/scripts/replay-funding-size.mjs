#!/usr/bin/env node
// replay-funding-size.mjs - ПРОГОН ПРАВИЛА РАЗМЕРА ВХОДА БОТА 1 ПО ГОДОВЫМ ФИКСТУРАМ. READ-ONLY.
//
// ЗАЧЕМ. У леджера бота 1 книга есть (`base-fa.tsv` и `base-fa-dil.tsv`), а у ПРАВИЛА ВХОДА не было
// ничего: юнит-тесты стерегут каждое ограничение по отдельности, но не стерегут ИТОГ решения на
// настоящих данных. Между «каждая часть верна» и «решение верно» помещается целый класс дефектов:
// перепутанный порядок ограничений, потерянный потолок, отбор, посчитанный на размере, которым мы
// не войдём.
//
// ЗДЕСЬ РЕШЕНИЕ ПРИНИМАЕТ ПРАВИЛО. Подменены ТОЛЬКО снабжение и часы:
//   источник рынка   - часовые строки фикстуры и снимки баз вместо живого REST;
//   ёмкость и удары  - снимки репозитория вместо живого стакана;
//   часы             - метка строки вместо Date.now.
// Дальше зовутся настоящие входные точки и ничего кроме них: `scanTwoLeg` выбирает конфигурацию
// ноги, `bestSizeForMarket` считает размер, `sizeUniverse` распределяет капитал. Если бы прогон
// повторил хоть одно из этих решений, это была бы вторая реализация правила, и доказывала бы она
// только сама себя.
//
// ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО: контролей `dilution-off` и `dilution-wrong`. Они уже стоят на книге
// разбавления `base-fa-dil.tsv` и глушат правило `fa/dilution.js`, а не правило размера. Контроль,
// повторённый на второй книге, стережёт то же самое дважды и создаёт впечатление большего покрытия,
// чем есть. Здесь глушатся ограничения САМОГО правила входа.
//
// ГРАНИЦЫ - в конце отчёта, и читать их обязательно.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpreadCsv } from "../src/engine/format.js";
import { baseUsd } from "../src/engine/fa/dilution.js";
import { scanTwoLeg } from "../src/engine/math.js";
import { DEFAULT_COSTS } from "../src/engine/costs.js";
import { FA_SIZING_DEFAULTS, explainSize, sizeUniverse } from "../src/engine/fa/sizing.js";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

const DROPS = Object.freeze({
  "ceiling-off": "О2 снят: потолок разбавления не ограничивает",
  "room-off": "О1 снят: свободная ликвидность и стакан не ограничивают",
  "tail-open": "О3 снят: экстраполяция кривой стакана разрешена",
  "ticket-off": "потолок тикета снят",
  "ratio-off": "отбор рынка снят (k = 0)",
  "flip-on": "О6 включён поверх боевого",
  "grid-coarse": "шаг сетки 10^0.5 и без золотого сечения",
  "bases-off": "базы фандинга не передаются вовсе",
  "weighted-base-off": "О2 считается по базе НА ВХОДЕ вместо взвешенной потоком",
  "impact-off": "измеренные кривые удара не передаются",
  "capital-off": "потолок капитала снят",
});

if (args.includes("--help")) {
  console.log(`replay-funding-size.mjs - прогон правила размера входа по годовым фикстурам

  --fixtures <каталог>  каталог с CSV кэша ставок (по умолчанию test/fixtures)
  --data <каталог>      биржевые данные бота 1 (по умолчанию ../data/funding-arb)
  --tokens <A,B,C>      инструменты (по умолчанию APT,BTC,ETH)
  --capital <$>         потолок капитала на блок (по умолчанию 20000)
  --book <файл>         записать книгу (TSV)
  --drop-rule <имя>     КОНТРОЛЬ: заглушить одно ограничение и убедиться, что книга это заметит:
${Object.entries(DROPS).map(([k, v]) => `                        ${k.padEnd(18)} ${v}`).join("\n")}`);
  process.exit(0);
}

const FIXTURES = resolve(APP, argOf("--fixtures", "test/fixtures"));
const DATA = resolve(APP, argOf("--data", "../data/funding-arb"));
const TOKENS = String(argOf("--tokens", "APT,BTC,ETH")).split(",").map((s) => s.trim()).filter(Boolean);
const CAPITAL = Number(argOf("--capital", "20000"));
const BOOK = argOf("--book");
const DROP = argOf("--drop-rule");
// Неизвестное имя правила молча ничего не глушило бы, и книга сошлась бы с эталонной: опечатка в
// имени контроля превращала бы контроль в его отсутствие, причём с успокаивающим выводом.
if (DROP != null && !(DROP in DROPS)) {
  console.error(`--drop-rule: ${Object.keys(DROPS).join(" | ")}, получено «${DROP}»`);
  process.exit(1);
}
if (!(CAPITAL > 0)) { console.error("--capital: положительное число"); process.exit(1); }

const H = FA_SIZING_DEFAULTS.horizonH;
const f6 = (x) => (Number.isFinite(x) ? x.toFixed(6) : "н-д");
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : "н-д");

// ── Конфигурация правила. Контроль меняет НАСТРОЙКУ, а не код: заглушить ограничение можно только
// тем же способом, каким его вооружает приложение.
const cfg = { ...FA_SIZING_DEFAULTS };
if (DROP === "ceiling-off") cfg.maxDilutionFraction = 1;
if (DROP === "tail-open") cfg.allowExtrapolation = true;
if (DROP === "ticket-off") cfg.ticketCapUsd = Infinity;
if (DROP === "ratio-off") cfg.fundRatioK = 0;
if (DROP === "flip-on") cfg.flipGuard = true;
if (DROP === "grid-coarse") { cfg.gridStepLog10 = 0.5; cfg.goldenIters = 0; }
const capital = DROP === "capital-off" ? Infinity : CAPITAL;

// ── Ставки и почасовые базы, выровненные по tsHour. Пропуск часа в одном из рядов иначе сдвинул бы
// весь остаток года и дал бы правдоподобную неверную книгу.
let available;
try { available = readdirSync(FIXTURES); }
catch { console.error(`нет каталога фикстур: ${FIXTURES}`); process.exit(1); }
const frames = new Map();
for (const token of TOKENS) {
  if (!available.includes(`${token}.csv`)) {
    console.error(`нет фикстуры ${token}.csv в ${FIXTURES} (есть: ${available.filter((f) => f.endsWith(".csv")).join(", ") || "ни одной"})`);
    process.exit(1);
  }
  const rows = parseSpreadCsv(readFileSync(join(FIXTURES, `${token}.csv`), "utf8"));
  if (!rows.length) { console.error(`фикстура ${token}.csv пуста`); process.exit(1); }
  let bases;
  try { bases = JSON.parse(gunzipSync(readFileSync(join(DATA, "gmx-oi-snapshots", `${token}.json.gz`))).toString("utf8")).oi; }
  catch { console.error(`нет баз фандинга для ${token} в ${join(DATA, "gmx-oi-snapshots")}`); process.exit(1); }
  const m = new Map(bases.map((r) => [Number(r.snapshotTimestamp), r]));
  frames.set(token, rows.map((r) => {
    const o = DROP === "bases-off" ? null : m.get(r.tsHour);
    return o ? { ...r, fbase_long: baseUsd(o.longFundingBalanceOiUsd), fbase_short: baseUsd(o.shortFundingBalanceOiUsd) } : r;
  }));
}

// ── Ёмкость и измеренные кривые удара. Это СНИМКИ, а не летопись: ёмкость снята 2026-08-30, а окна
// удержания относятся к 2025-06..2026-06, то есть место на рынке за год менялось и перенос не
// проверен. Живое правило берёт место из живой выдачи, снимок остаётся только для этого прогона.
const caps = JSON.parse(readFileSync(join(DATA, "snapshots", "cap63.json"), "utf8"));
const hlImpact = JSON.parse(gunzipSync(readFileSync(join(DATA, "hl", "impact-hl.json.gz"))).toString("utf8")).tokens;
const gmxImpact = JSON.parse(gunzipSync(readFileSync(join(DATA, "gmx-impact", "impact-gmx.json.gz"))).toString("utf8")).interp;
// Узлы кривой стакана Hyperliquid, на которых она ИЗМЕРЕНА. Последний из них и есть тот край, за
// который правило не ходит при выключенной экстраполяции.
const HL_NODES_USD = [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000];

// ЗНАК ПРИВОДИТСЯ ЗДЕСЬ И ОДИН РАЗ. В первоисточнике `adverseBps` отрицателен, когда платит
// трейдер, а модуль принимает ИЗДЕРЖКУ, то есть неотрицательное число. Приведение в двух местах
// дало бы удар с обратным знаком, то есть доход от собственной сделки.
function impactFor(token, gmxSide) {
  if (DROP === "impact-off") return null;
  const g = gmxImpact[token]?.[gmxSide] || [];
  const hl = hlImpact[token];
  return {
    gmxNodes: g.map((n) => ({ sizeUsd: n.sizeUsd, bps: Math.max(0, -(n.adverseBps ?? 0)) })),
    // Круг стакана это проходка покупки ПЛЮС проходка продажи, и он одинаков в обеих конфигурациях:
    // одна из них покупает на входе и продаёт на выходе, вторая наоборот.
    hlNodes: hl ? HL_NODES_USD.map((x, i) => ({ sizeUsd: x, bps: (hl.raw.buy.bps[i] ?? 0) + (hl.raw.sell.bps[i] ?? 0) })) : [],
  };
}

function roomFor(token, gmxSide) {
  if (DROP === "room-off") return {};
  const c = caps.find((x) => x.t === token);
  const hl = hlImpact[token];
  return {
    gmxAvailOwnUsd: c ? (gmxSide === "short" ? c.availShort : c.availLong) : undefined,
    hlVisibleNtl: hl ? Math.min(hl.raw.buy.visibleNtl, hl.raw.sell.visibleNtl) : undefined,
    hlExhaustedFrom: hl ? (hl.raw.buy.exhaustedFrom ?? hl.raw.sell.exhaustedFrom ?? undefined) : undefined,
  };
}

// ── Блоки по 720 часов, НЕПЕРЕСЕКАЮЩИЕСЯ. Конфигурацию ноги на блоке k выбирает `scanTwoLeg` по
// блоку k-1: правило так и работает, и мерить его на всём годе разом значило бы дать ему заглянуть
// вперёд. Блок 0 служит только обучающим.
const len = Math.min(...TOKENS.map((t) => frames.get(t).length));
const blocks = [];
for (let i = H; i + H <= len; i += H) blocks.push(i);
if (!blocks.length) { console.error(`истории меньше двух блоков по ${H} ч (${len} строк)`); process.exit(1); }

const bookRows = [];
const summary = [];
for (const start of blocks) {
  const markets = [];
  for (const token of TOKENS) {
    const rows = frames.get(token);
    const scan = scanTwoLeg(rows.slice(start - H, start), { token });
    if (!scan) continue;
    const config = scan.chosen;
    const gmxSide = config === "A" ? "short" : "long";
    const seg = rows.slice(start, start + H);
    const last = seg[seg.length - 1];
    // База НА ВХОДЕ: она нужна воротам данных и строгому режиму. Потолок О2 при этом считается по
    // базе, ВЗВЕШЕННОЙ ПОТОКОМ, внутри правила, а контроль `weighted-base-off` подменяет окно
    // одной строкой и тем самым возвращает прежнюю, опровергнутую форму ограничения.
    const bOwnUsd = gmxSide === "short" ? last.fbase_short : last.fbase_long;
    const bOtherUsd = gmxSide === "short" ? last.fbase_long : last.fbase_short;
    markets.push({
      token, config, strategy: "two",
      rows: DROP === "weighted-base-off" ? seg.map((r) => ({ ...r, fbase_long: last.fbase_long, fbase_short: last.fbase_short })) : seg,
      live: { bOwnUsd, bOtherUsd, ...roomFor(token, gmxSide) },
      impact: impactFor(token, gmxSide),
      tsHour: seg[0].tsHour,
    });
  }
  const u = sizeUniverse({ markets, costs: DEFAULT_COSTS, capitalTotal: capital, cfg });
  const byToken = new Map(u.curves.map((c) => [c.token, c]));
  for (const m of markets) {
    const d = byToken.get(m.token) || { refusal: "no_base" };
    const alloc = u.alloc.get(m.token);
    bookRows.push([
      bookRows.length + 1, m.token, blocks.indexOf(start) + 1,
      new Date(m.tsHour * 1000).toISOString().slice(0, 10), m.config,
      f6(d.flowWeightedBaseUsd), f6(d.ceilingUsd), d.binding ?? "-",
      f6(d.starUsd), f0(d.sizeUsd), f6(d.netUsd), f6(d.grossUsd),
      f6(d.parts?.gmxFundingUsd), f6(d.parts?.gmxBorrowUsd), f6(d.parts?.hlUsd),
      f6(d.costUsd), f6(d.ratio), f6(d.ratioAtStar), f6(d.dilutionRetained),
      f0(alloc), d.refusal ?? "-",
    ]);
  }
  summary.push({ start, u, markets });
}

const HEAD = ["#", "инструмент", "блок", "начало", "конфиг", "база взвеш.", "потолок", "связывает",
  "оптимум", "размер", "нетто", "брутто", "фандинг GMX", "борроу GMX", "HL", "круг",
  "отношение", "отношение при S*", "множитель", "выдано", "отказ"];
if (BOOK) writeFileSync(BOOK, `${[HEAD.join("\t"), ...bookRows.map((r) => r.join("\t"))].join("\n")}\n`);

// ── Отчёт.
console.log(`# Прогон правила размера входа бота 1 по годовым фикстурам\n`);
console.log(`Фикстуры ${FIXTURES}; данные ${DATA}; инструменты ${TOKENS.join(", ")}.`);
console.log(`Горизонт ${H} ч, блоков ${blocks.length} (блок 0 только обучающий), капитал на блок `
  + `${Number.isFinite(capital) ? `$${capital}` : "БЕЗ ПОТОЛКА"}.`);
console.log(`Потолок тикета ${Number.isFinite(cfg.ticketCapUsd) ? `$${cfg.ticketCapUsd}` : "снят"}, `
  + `запас отбора k = ${cfg.fundRatioK}, сжатие к единому размеру w = ${cfg.shrinkToUniform}.`);
if (DROP) console.log(`\nКОНТРОЛЬ: заглушено «${DROP}» (${DROPS[DROP]}). Книга ОБЯЗАНА разойтись с эталонной.`);

console.log(`\n## Решения по блокам\n`);
for (const s of summary) {
  console.log(`### блок ${blocks.indexOf(s.start) + 1}, с ${new Date(s.markets[0].tsHour * 1000).toISOString().slice(0, 10)}`);
  for (const c of s.u.curves) console.log(`  ${explainSize(c)}`);
  const alloc = [...s.u.alloc].map(([k, v]) => `${k} $${v.toFixed(0)}`).join(", ");
  console.log(`  распределено: ${alloc || "ничего"}; занято $${s.u.usedUsd.toFixed(0)}; нетто портфеля $${s.u.netTotal.toFixed(2)}`);
}

// Сводка отказов: она отвечает на вопрос «почему рынков мало», а он в этой стратегии главный.
const tally = new Map();
for (const s of summary) for (const r of s.u.refusals) tally.set(r.refusal, (tally.get(r.refusal) || 0) + 1);
console.log(`\n## Отказы, всего решений ${bookRows.length}\n`);
if (!tally.size) console.log(`  ни одного`);
for (const [code, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${code.padEnd(26)} ${n}`);

const funded = bookRows.filter((r) => r[r.length - 1] === "-").length;
console.log(`\nпрофинансировано решений: ${funded} из ${bookRows.length}`);
console.log(`\nКнига: ${bookRows.length} строк${BOOK ? ` записана в ${BOOK}` : " (не записана: нет --book)"}.`);

console.log(`\n## Границы: чего этот прогон НЕ проверяет\n`);
console.log(`- ЖИВОЕ СНАБЖЕНИЕ: ни sources.js, ни стакан Hyperliquid сюда не заходят, поэтому дефект`);
console.log(`  сбора и разбор возрастов данных этой книгой не ловятся (для них есть живой смоук);`);
console.log(`- ЁМКОСТЬ И УДАРЫ это СНИМОК 2026-08-30 против окон 2025-06..2026-06: место на рынке за`);
console.log(`  год менялось, и перенос снимка на прошлое не проверен;`);
console.log(`- ГОРИЗОНТ удержания приходит снаружи и правилом не выбирается. Живьём он не наблюдаем в`);
console.log(`  принципе, а ответ зависит от него на четыре порядка по капиталу;`);
console.log(`- ДОХОДНОСТЬ отсюда НЕ следует: три инструмента это не вселенная, а размер выбирается по`);
console.log(`  предшествующему блоку, то есть числа честны по методу, но не по выборке.`);
