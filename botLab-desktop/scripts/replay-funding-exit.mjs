#!/usr/bin/env node
// replay-funding-exit.mjs - ПРОГОН ПРАВИЛА ВЫХОДА БОТА 1 ПО ГОДОВЫМ ФИКСТУРАМ. READ-ONLY.
//
// ЗАЧЕМ ЕЩЁ ОДНА КНИГА. У правила ВХОДА книга есть (`base-fa-size.tsv`), и она стережёт решение
// «каким размером и на каком рынке войти». Правило ВЫХОДА принимает решение ДРУГОГО рода: держать,
// уйти в кэш или переложиться. Между «каждая ветка верна» (юнит-тесты) и «последовательность
// решений верна» помещается целый класс дефектов, которого юнит-тест не видит по определению:
// холостой оборот, храповик по размеру, потерянный отказ снабжения, перепутанные брутто и нетто.
// Всё это видно только на ЦЕПОЧКЕ решений по настоящим данным.
//
// ЗДЕСЬ РЕШЕНИЕ ПРИНИМАЕТ ПРАВИЛО. Подменены только снабжение и часы: часовые строки фикстуры и
// снимки баз вместо живого REST, снимки ёмкости и измеренных ударов вместо живого стакана, метка
// строки вместо Date.now. Дальше зовутся настоящие входные точки: `scanTwoLeg` выбирает сторону,
// `decideExit` принимает решение и внутри себя зовёт правило входа целиком.
//
// ЧЕСТНОСТЬ ВРЕМЕНИ. Решение в час t принимается по трейлингу [t-H, t). Реализованный доход
// считается по строкам ПОСЛЕ t и в решение не заходит никогда. Смешать эти два ряда значит дать
// правилу заглянуть вперёд.
//
// БУХГАЛТЕРИЯ. Открывая позицию размера S, списываем ПОЛНЫЙ круг сразу; удержание и закрытие
// бесплатны. Это ровно та бухгалтерия, в которой посчитано `netUsd` правила входа, поэтому решения
// и итог считаются в одних деньгах.
//
// ПРО КОНТРОЛИ. Часть из них (`switch-off`, `sunk-in`, `same-market-skip`) это НЕ
// настройки, а НЕВЕРНЫЕ КРИТЕРИИ, и они пересобираются здесь из тех же трёх чисел, которые вернул
// модуль. Такой контроль проверяет ЧУВСТВИТЕЛЬНОСТЬ КНИГИ к конкретной ошибке конструкции, а не
// ветку кода модуля, и это сказано вслух, чтобы никто не принял одно за другое. Ошибки выбраны не
// произвольно: `sunk-in` это подстановка нетто вместо брутто в ветку удержания (вычесть круг
// дважды), а `same-market-skip` это соблазнительная оптимизация «лучшая альтернатива это текущий
// рынок, значит менять нечего», которая убивает смену размера на месте.
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
import { FA_SIZING_DEFAULTS, netAtSize } from "../src/engine/fa/sizing.js";
import { FA_EXIT_DEFAULTS, decideExit } from "../src/engine/fa/exit.js";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

// ПОЧЕМУ ЗДЕСЬ НЕТ КОНТРОЛЯ `cash-off`, ХОТЯ ВЕТКА КЭША В ПРАВИЛЕ ЕСТЬ. Он был написан и ПРОВЕРЕН:
// книга с ним совпадает с эталонной ПОБИТОВО, потому что ветка кэша на этих данных не срабатывает
// ни разу. Контроль, который не может уронить свою книгу, это не контроль, а успокаивающий вывод, и
// держать его здесь значило бы обещать покрытие, которого нет.
//
// Ветка кэша при этом НЕ БЕЗ ОХРАНЫ: юнит-тест `fa-exit.test.js` доводит до неё правило на тех же
// фикстурах (час 1440, где правило ВХОДА отказывает всем трём рынкам, а брутто удержания BTC равно
// -12.312339), а `npm test` это первый шаг охраны. Её редкость не случайность: на рабочем наборе из
// 63 рынков она не сработала ни разу за 8041 решение, потому что перекладка её всегда накрывает.
//
// Контроля `cadence-1` тоже нет, и причина прозаическая: 8041 точка решения против 336 это семь
// минут вместо тридцати секунд, а книга бота 1 обязана оставаться дешёвой. Каданс проверяет
// `cadence-720`.
const DROPS = Object.freeze({
  "switch-off": "ветка перекладки выключена: только держать или в кэш",
  "sunk-in": "ОШИБКА КОНСТРУКЦИИ: ветка удержания берёт НЕТТО вместо брутто (круг вычтен дважды)",
  "same-market-skip": "ОШИБКА КОНСТРУКЦИИ: текущий рынок исключён из альтернатив (убивает смену размера)",
  "horizon-half": "горизонт вдвое короче (360 ч вместо 720)",
  "ratio-off": "отбор рынка снят (k = 0): в альтернативы попадает всё подряд",
  "ticket-off": "потолок тикета снят",
  "cadence-720": "каданс 720 ч вместо 24",
});

if (args.includes("--help")) {
  console.log(`replay-funding-exit.mjs - прогон правила выхода по годовым фикстурам

  --fixtures <каталог>  каталог с CSV кэша ставок (по умолчанию test/fixtures)
  --data <каталог>      биржевые данные бота 1 (по умолчанию ../data/funding-arb)
  --tokens <A,B,C>      инструменты (по умолчанию APT,BTC,ETH)
  --capital <$>         капитал одной сделки (по умолчанию 5000)
  --book <файл>         записать книгу (TSV)
  --drop-rule <имя>     КОНТРОЛЬ: подменить одно правило и убедиться, что книга это заметит:
${Object.entries(DROPS).map(([k, v]) => `                        ${k.padEnd(18)} ${v}`).join("\n")}`);
  process.exit(0);
}

const FIXTURES = resolve(APP, argOf("--fixtures", "test/fixtures"));
const DATA = resolve(APP, argOf("--data", "../data/funding-arb"));
const TOKENS = String(argOf("--tokens", "APT,BTC,ETH")).split(",").map((s) => s.trim()).filter(Boolean);
const CAPITAL = Number(argOf("--capital", 5000));
const BOOK = argOf("--book");
const DROP = argOf("--drop-rule");
// Неизвестное имя правила молча ничего не подменило бы, и книга сошлась бы с эталонной: опечатка в
// имени контроля превращала бы контроль в его отсутствие, причём с успокаивающим выводом.
if (DROP != null && !(DROP in DROPS)) {
  console.error(`--drop-rule: ${Object.keys(DROPS).join(" | ")}, получено «${DROP}»`);
  process.exit(1);
}
if (!(CAPITAL > 0)) { console.error("--capital: положительное число"); process.exit(1); }

// ── Конфигурация. Контроли-НАСТРОЙКИ меняют её тем же способом, каким её вооружает приложение.
const cfg = { ...FA_SIZING_DEFAULTS };
if (DROP === "horizon-half") cfg.horizonH = FA_SIZING_DEFAULTS.horizonH / 2;
if (DROP === "ratio-off") cfg.fundRatioK = 0;
if (DROP === "ticket-off") cfg.ticketCapUsd = Infinity;
const H = cfg.horizonH;
const CADENCE = DROP === "cadence-720" ? 720 : FA_EXIT_DEFAULTS.decisionIntervalHours;

const f6 = (x) => (Number.isFinite(x) ? x.toFixed(6) : "н-д");
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : "н-д");

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
    const o = m.get(r.tsHour);
    return o ? { ...r, fbase_long: baseUsd(o.longFundingBalanceOiUsd), fbase_short: baseUsd(o.shortFundingBalanceOiUsd) } : r;
  }));
}

// ── Ёмкость и измеренные кривые удара. Это СНИМКИ, а не летопись: ёмкость снята 2026-08-30, а окна
// относятся к 2025-06..2026-06. Живое правило берёт место из живой выдачи.
const caps = JSON.parse(readFileSync(join(DATA, "snapshots", "cap63.json"), "utf8"));
const hlImpact = JSON.parse(gunzipSync(readFileSync(join(DATA, "hl", "impact-hl.json.gz"))).toString("utf8")).tokens;
const gmxImpact = JSON.parse(gunzipSync(readFileSync(join(DATA, "gmx-impact", "impact-gmx.json.gz"))).toString("utf8")).interp;
const HL_NODES_USD = [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000];

// ЗНАК ПРИВОДИТСЯ ЗДЕСЬ И ОДИН РАЗ: в первоисточнике `adverseBps` отрицателен, когда платит трейдер,
// а правило принимает ИЗДЕРЖКУ, то есть неотрицательное число.
function impactFor(token, gmxSide) {
  const g = gmxImpact[token]?.[gmxSide] || [];
  const hl = hlImpact[token];
  return {
    gmxNodes: g.map((n) => ({ sizeUsd: n.sizeUsd, bps: Math.max(0, -(n.adverseBps ?? 0)) })),
    hlNodes: hl ? HL_NODES_USD.map((x, i) => ({ sizeUsd: x, bps: (hl.raw.buy.bps[i] ?? 0) + (hl.raw.sell.bps[i] ?? 0) })) : [],
  };
}

function roomFor(token, gmxSide) {
  const c = caps.find((x) => x.t === token);
  const hl = hlImpact[token];
  return {
    gmxAvailOwnUsd: c ? (gmxSide === "short" ? c.availShort : c.availLong) : undefined,
    hlVisibleNtl: hl ? Math.min(hl.raw.buy.visibleNtl, hl.raw.sell.visibleNtl) : undefined,
    hlExhaustedFrom: hl ? (hl.raw.buy.exhaustedFrom ?? hl.raw.sell.exhaustedFrom ?? undefined) : undefined,
  };
}

// Срез вселенной НА МОМЕНТ РЕШЕНИЯ. Живой снимок это ПОСЛЕДНЯЯ наблюдённая строка t-1: взять строку
// t значило бы прочитать час, который в момент решения ещё не закрылся.
function sliceAt(t) {
  const out = [];
  for (const token of TOKENS) {
    const rows = frames.get(token);
    const trailing = rows.slice(t - H, t);
    if (trailing.length !== H) continue;
    const config = scanTwoLeg(trailing, { token })?.chosen;
    if (!config) continue;
    const gmxSide = config === "A" ? "short" : "long";
    const last = trailing[trailing.length - 1];
    out.push({
      token, config, strategy: "two", rows: trailing, gmxSide,
      live: {
        bOwnUsd: gmxSide === "short" ? last.fbase_short : last.fbase_long,
        bOtherUsd: gmxSide === "short" ? last.fbase_long : last.fbase_short,
        ...roomFor(token, gmxSide),
      },
      impact: impactFor(token, gmxSide),
      tsHour: last.tsHour,
    });
  }
  return out;
}

const grossOn = (token, config, sizeUsd, from, len) => {
  const rows = frames.get(token);
  const seg = rows.slice(from, from + len);
  if (seg.length !== len) return NaN;
  const r = netAtSize({
    rows: seg, config, strategy: "two", sizeUsd, costs: DEFAULT_COSTS,
    impact: impactFor(token, config === "A" ? "short" : "long"), cfg,
  });
  return r ? r.gross : NaN;
};

// ── Обход. Одна позиция за раз: правило выхода фазы 3 решает по одной сделке.
const LEN = Math.min(...TOKENS.map((t) => frames.get(t).length));
const bookRows = [];
let pos = null;
let realized = 0;
let costs = 0;
const tally = new Map();

const accrueTo = (t) => {
  if (!pos || t <= pos.at) return;
  const g = grossOn(pos.token, pos.config, pos.sizeUsd, pos.at, t - pos.at);
  if (Number.isFinite(g)) realized += g;
  pos.at = t;
};

for (let t = H; t <= LEN; t += CADENCE) {
  const slice = sliceAt(t);
  if (!slice.length) continue;
  accrueTo(t);
  const tsHour = slice[0].tsHour;

  if (!pos) {
    // ВХОДА У ПРАВИЛА ВЫХОДА НЕТ, и это не пробел. Первый вход и вход после кэша делает правило
    // ВХОДА, здесь оно зовётся напрямую тем же `decideExit` с пустой позицией нельзя, поэтому
    // берётся лучшая профинансированная кривая из его же результата.
    const probe = decideExit({ position: { token: slice[0].token, config: slice[0].config, strategy: "two", sizeUsd: CAPITAL },
      rows: slice[0].rows, markets: slice, capitalAvailableUsd: CAPITAL, costs: DEFAULT_COSTS, cfg });
    let best = null;
    for (const c of probe.curves) {
      if (c.refusal || !(c.sizeUsd > 0) || c.sizeUsd > CAPITAL) continue;
      if (!best || c.netUsd > best.netUsd) best = c;
    }
    if (best && best.netUsd > 0) {
      pos = { token: best.token, config: best.config, sizeUsd: best.sizeUsd, at: t };
      costs += best.costUsd;
      tally.set("вход", (tally.get("вход") || 0) + 1);
      bookRows.push([bookRows.length + 1, t, new Date(tsHour * 1000).toISOString().slice(0, 13).replace("T", " "),
        "-", "-", "вход", "-", f6(best.netUsd), best.token, best.config, f0(best.sizeUsd),
        f6(best.netUsd), "-", f6(best.costUsd), f6(realized), f6(costs)]);
    } else {
      tally.set("простой", (tally.get("простой") || 0) + 1);
    }
    continue;
  }

  const held = slice.find((m) => m.token === pos.token);
  const rows = held ? held.rows : frames.get(pos.token).slice(t - H, t);
  const d = decideExit({
    position: { token: pos.token, config: pos.config, strategy: "two", sizeUsd: pos.sizeUsd },
    rows, markets: slice, capitalAvailableUsd: CAPITAL, costs: DEFAULT_COSTS, cfg,
  });

  // ── КОНТРОЛИ-КРИТЕРИИ. Пересобираются из тех же трёх чисел, что вернул модуль.
  let action = d.action;
  let best = d.best;
  let holdValue = d.holdGrossUsd;
  if (DROP && d.action !== "defer") {
    if (DROP === "same-market-skip") {
      // Соблазнительная оптимизация: текущий рынок из альтернатив исключён. Убивает смену размера
      // на месте, которая на рабочем наборе была самой частой перекладкой (25 из 46).
      best = null;
      for (const c of d.curves) {
        if (c.refusal || c.token === pos.token || !(c.sizeUsd > 0) || c.sizeUsd > CAPITAL) continue;
        if (!best || c.netUsd > best.netUsd) best = c;
      }
    }
    if (DROP === "sunk-in") {
      // Круг вычтен дважды: в ветке удержания он не платится вовсе.
      const own = d.curves.find((c) => c.token === pos.token && !c.refusal);
      holdValue = d.holdGrossUsd - (own ? own.costUsd : 0);
    }
    const sw = best ? best.netUsd : null;
    action = "hold";
    let v = holdValue;
    if (0 > v) { action = "close"; v = 0; }
    if (DROP !== "switch-off" && Number.isFinite(sw) && sw > v) { action = "switch"; v = sw; }
  }

  tally.set(action, (tally.get(action) || 0) + 1);
  const gain = best && Number.isFinite(d.holdGrossUsd) ? best.netUsd - d.holdGrossUsd : NaN;
  bookRows.push([bookRows.length + 1, t, new Date(tsHour * 1000).toISOString().slice(0, 13).replace("T", " "),
    `${pos.token}/${pos.config}`, f0(pos.sizeUsd), action, d.reason,
    f6(d.holdGrossUsd), best ? best.token : "-", best ? best.config : "-", best ? f0(best.sizeUsd) : "-",
    best ? f6(best.netUsd) : "н-д", Number.isFinite(gain) ? f6(gain) : "н-д",
    best ? f6(best.costUsd) : "н-д", f6(realized), f6(costs)]);

  if (action === "close") pos = null;
  else if (action === "switch" && best) {
    pos = { token: best.token, config: best.config, sizeUsd: best.sizeUsd, at: t };
    costs += best.costUsd;
  }
}
accrueTo(LEN);

const HEAD = ["#", "час", "дата", "держим", "размер", "действие", "причина", "брутто удержания",
  "альт", "конфиг альт", "размер альт", "нетто альт", "прибавка", "круг альт", "реализовано", "издержки"];
if (BOOK) writeFileSync(BOOK, `${[HEAD.join("\t"), ...bookRows.map((r) => r.join("\t"))].join("\n")}\n`);

// ── Отчёт.
console.log(`# Прогон правила выхода бота 1 по годовым фикстурам\n`);
console.log(`Фикстуры ${FIXTURES}; данные ${DATA}; инструменты ${TOKENS.join(", ")}.`);
console.log(`Горизонт ${H} ч, каданс ${CADENCE} ч, капитал сделки $${CAPITAL}, одна позиция за раз.`);
if (DROP) console.log(`\nКОНТРОЛЬ: подменено «${DROP}» (${DROPS[DROP]}). Книга ОБЯЗАНА разойтись с эталонной.`);

console.log(`\n## Итог\n`);
console.log(`решений в книге: ${bookRows.length}`);
for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(k).padEnd(10)} ${v}`);
console.log(`\nреализовано брутто $${realized.toFixed(2)}; издержки $${costs.toFixed(2)}; нетто $${(realized - costs).toFixed(2)}`);

console.log(`\n## Границы: чего этот прогон НЕ проверяет\n`);
console.log(`- ТРИ ИНСТРУМЕНТА это не вселенная. Ветка перекладки выбирает лучшее из трёх, а живьём`);
console.log(`  выбирает из 63, поэтому доходность отсюда НЕ следует ни в какую сторону;`);
console.log(`- ЖИВОЕ СНАБЖЕНИЕ сюда не заходит: дефект сбора и разбор возрастов данных этой книгой не`);
console.log(`  ловятся, для них есть живой смоук;`);
console.log(`- ЁМКОСТЬ И УДАРЫ это СНИМОК 2026-08-30 против окон 2025-06..2026-06;`);
console.log(`- КАДАНС здесь фиксирован, а автомат, который его исполняет, это фаза 4.`);
