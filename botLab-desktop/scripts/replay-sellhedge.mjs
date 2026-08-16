#!/usr/bin/env node
// replay-sellhedge.mjs - ПРОГОН ИСТОРИИ ЧЕРЕЗ ЖИВОЙ ДВИЖОК БОТА 2. READ-ONLY.
//
// ЗАЧЕМ, И ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ПАРНОЙ СВЕРКИ. `parity-sellhedge.mjs` строит цепочку сделок
// ПРАВИЛАМИ ЭТАЛОНА и подменяет ровно одно правило - решение хеджа. Он отвечает на вопрос «если дать
// движку тот же инструмент в те же моменты, согласится ли он по хеджу» (ответ: 0 расхождений из 43
// тысяч). Он НЕ отвечает ни на один из следующих: выбрал бы движок тот же контракт сам, открыл бы в
// те же моменты, дал бы его гейт размера то же число лотов, сошлась бы книга сделок целиком.
//
// ЗДЕСЬ ДВИЖОК ВЕДЁТ СДЕЛКУ САМ. Подменён ТОЛЬКО слой снабжения: вместо `createRestSource` снимки
// собираются из записи. Дальше зовутся настоящие входные точки бота 2 и ничего кроме них:
//   s1engine.create      - то же состояние, что живёт в btc-options-state.json;
//   s1engine.openStructure({ kind: "sell-call" }) - выбор контракта (`pickSellLeg`) и размер
//                          (`lotsByMargin`) идут внутрь, в sellhedge.js; здесь их нет;
//   s1engine.ingest      - начисление фандинга на держимый перп;
//   s1engine.evaluate    - расчёт в экспирацию, `decideHedge`, `applyFill`, атрибуция, счёт, леджер.
// Если бы для прогона пришлось повторить хоть одно из этих решений, это была бы не сверка, а
// ЧЕТВЁРТАЯ реализация правил, и доказывала бы она только сама себя. Проверка на это встроена:
// `--drop-rule <имя>` глушит одно правило движка и обязана СЛОМАТЬ сверку (см. ниже).
//
// ЧТО ПОДМЕНЕНО, ПОИМЕННО:
//   источник рынка   - снимки записи вместо REST-опроса Deribit;
//   часы             - метка снимка вместо Date.now (закон движка это уже требовал: nowMs аргумент);
//   исполнение       - перп заполняется по споту записи (стакана перпа в записи нет), опцион входит
//                      по правилам эталона (mid ± половина модельного спреда × spreadScale).
//
// ЦЕНА ИНСТРУМЕНТА В СНИМКЕ БЕРЁТСЯ ЛЕСТНИЦЕЙ `hist-price.js`, той же, что у эталона, и счётчик
// ступеней печатается. Наивное «нет строки - нет наблюдения» есть отбор по исходу: строка пропадает
// ровно на больших движениях, и однажды это стоило проекту около ста процентных пунктов.
//
// ЧЕГО ПРОГОН ПО ЗАПИСИ НЕ ПРОВЕРЯЕТ В ПРИНЦИПЕ - раздел «Границы» в конце отчёта.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gunzipSync } from "node:zlib";
import { priceAt, makePriceStats, countPrice, formatPriceStats } from "../src/engine/otmscan/hist-price.js";
import { shouldOpenNext } from "../src/engine/otmscan/sellhedge.js";
import * as s1engine from "../src/engine/btcopt/engine.js";

const fin = (x) => Number.isFinite(x);
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const has = (n) => args.includes(n);

if (has("--help") || !argOf("--dir")) {
  console.log(`replay-sellhedge.mjs - прогон записи через живой движок бота 2

  --dir <каталог>     запись восстановления (обязательно)
  --funding <файл>    почасовой фандинг перпа (по умолчанию из кэша hist-download)
  --deposit <$>       стартовый счёт (по умолчанию 20000)
  --qty <x>           фиксированный размер в контрактах; по умолчанию размер от залога
  --band <x>          полоса хеджа, BTC на 1.0 контракта (по умолчанию 0.03)
  --perp-fee <x>      комиссия перпа долей (0 мейкер; по умолчанию 0)
  --perp-cs <x>       размер обратного контракта, USD (по умолчанию 10 = реальный BTC-PERPETUAL).
                      ДИАГНОСТИКА: эталон торгует перп дробно, движок целыми контрактами. Мелкий
                      размер убирает гранулярность, не трогая ни одно произведение (qty·cs)
  --book <файл>       записать книгу сделок (TSV, тот же формат, что у эталона)
  --trades            печатать книгу в отчёт
  --trace <файл>      ДИАГНОСТИКА: дамп решений по сделке (ts, S, delta, want, have, fire)
  --trace-trade <n>   номер сделки для --trace (по умолчанию 1)
  --drop-rule <имя>   КОНТРОЛЬ: заглушить одно правило движка и убедиться, что сверка это заметит.
                      band-off (полосы нет) | size-off (размер 1 лот) |
                      pick-off (целевая дельта 0.30) | settle-late (выход на сутки позже)`);
  process.exit(argOf("--dir") ? 0 : 1);
}

const DIR = argOf("--dir");
const DEPOSIT = Number(argOf("--deposit", "20000"));
const QTY_FIXED = argOf("--qty") == null ? null : Number(argOf("--qty"));
const BAND = Number(argOf("--band", "0.03"));
const PERP_FEE = Number(argOf("--perp-fee", "0"));
const PERP_CS = Number(argOf("--perp-cs", "10"));
const DROP = argOf("--drop-rule");
const TRACE = argOf("--trace") ? ["ts\tS\tdelta\twant\thave\tfire"] : null;
const TRACE_TRADE = Number(argOf("--trace-trade", "1")); // какую сделку писать в трассу
const LOT = 0.01;

// ── ЗАПИСЬ. Загрузчик слово в слово тот же, что у эталона и у парной сверки: это слой СНАБЖЕНИЯ,
// и он обязан быть общим, иначе сверка мерила бы разницу двух читалок файлов.
function load(dir) {
  const D = readdirSync(dir).some((f) => f === "scan-records") ? join(dir, "scan-records") : dir;
  const snaps = new Map(); const ticks = [];
  for (const f of readdirSync(D).sort()) {
    const kind = f.includes("-ticks-") ? "t" : f.includes("-surface-") ? "s" : null;
    if (!kind) continue;
    for (const line of readFileSync(join(D, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (kind === "t") ticks.push(r);
      else { let m = snaps.get(r.ts); if (!m) { m = new Map(); snaps.set(r.ts, m); } m.set(r.n, r); }
    }
  }
  ticks.sort((a, b) => a.ts - b.ts);
  const times = [...snaps.keys()].sort((a, b) => a - b);
  const tts = ticks.map((t) => t.ts);
  const spot = times.map((t) => {
    let lo = 0, hi = tts.length - 1, res = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (tts[m] <= t) { res = m; lo = m + 1; } else hi = m - 1; }
    return res == null ? null : ticks[res].S ?? null;
  });
  const byExp = new Map();
  for (const [ts, m] of snaps) {
    const e = new Map();
    for (const r of m.values()) { let a = e.get(r.e); if (!a) { a = []; e.set(r.e, a); } a.push(r); }
    byExp.set(ts, e);
  }
  return { snaps, times, spot, byExp, stats: makePriceStats() };
}
const R = load(DIR);
const N = R.times.length;
if (!N) { console.error(`пусто: ${DIR}`); process.exit(1); }

const FUND = new Map();
{
  const rel = argOf("--funding") ?? join(homedir(), "botlab-hist-cache", "funding", "btc-perpetual-1h.json");
  for (const p of [rel, `${rel}.gz`]) {
    try {
      const buf = readFileSync(p);
      for (const f of JSON.parse((p.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8")))
        if (fin(f?.ts) && fin(f?.r1h)) FUND.set(Math.floor(f.ts / 3600000) * 3600000, f.r1h);
      break;
    } catch { /* следующий вариант пути */ }
  }
}
const fundRate = (ts) => FUND.get(Math.floor(ts / 3600000) * 3600000) ?? 0;
const spotBefore = (T) => { let lo = 0, hi = N - 1, res = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (R.times[m] <= T) { res = R.spot[m]; lo = m + 1; } else hi = m - 1; } return res; };

// ── НАСТРОЙКИ ДВИЖКА. Каждое отступление от дефолта бота 2 объявлено здесь, а не растворено в коде.
//
// ПОЛОСА И ТОЛЬКО ПОЛОСА. У схемы одно правило перекладки - разрыв дельты за полосой. У бота 2
// сверх этого есть триггер цены, триггер времени, фильтр выгоды λ и блэкаут расчёта; все четыре
// ИЗМЕНЯЮТ решения (замерено parity-sellhedge), поэтому для сверки книги они выключены. λ = 0
// оставляет гейт `benefit > 0`, то есть срабатывание ровно там, где |нужный − текущий| > полосы.
// СПОСОБ ВЫКЛЮЧЕНИЯ ТРИГГЕРОВ - недостижимый порог, а не отдельная ветка в движке: ветка «для
// прогона» была бы кодом, которого нет в бою.
//
// ПОЛОСА ЯКОРИТСЯ НА 1.0 КОНТРАКТА: `effectiveDeadband` масштабирует её размером структуры, а
// эталонные 0.03 BTC заданы на контракт. При deadbandRefQty = 1.0 позиция в q контрактов получает
// полосу 0.03·q - то же самое число, каким её меряет эталон.
//
// АНТИ-CATCH-UP КЛАМП ФАНДИНГА СНЯТ, И ЭТО ОБЯЗАТЕЛЬНО НАЗВАТЬ. Дефолт бота 2 - 300 с, а шаг записи
// 3600 с: с дефолтом каждое начисление урезалось бы до 1/12 и фандинг занизился бы в двенадцать раз.
// Кламп существует против разрыва тиков при засыпании машины (оценивать многочасовой разрыв текущей
// мгновенной ставкой неверно), но у ЧАСОВОЙ записи разрыва нет - есть её собственный шаг.
//
// ЧТО ИЗ ЭТОГО СПИСКА ДРАЙВЕР БОЛЬШЕ НЕ ЗАДАЁТ, И ЭТО ГЛАВНОЕ ИЗМЕНЕНИЕ СВЕРКИ. Полосу, λ, оба
// триггера и блэкаут расчёта теперь ставит САМ ДВИЖОК при открытии структуры-продавца
// (`sellhedgeEngineCfg` в sellhedge.js, применяется в `openStructure`). Пока их выставлял драйвер,
// сверка доказывала свойство СКРИПТА: «если движку вручную задать шесть чисел, он согласится с
// эталоном». Ответа на вопрос «а что сделает приложение с профилем по умолчанию» она не давала, и
// ответ был бы ×24.2 вместо ×46.5. Теперь драйвер их не трогает, и совпадение книги проверяет
// конфигурацию, которая реально доедет до боя.
const settings = {
  benefitMovePct: 0.5, // масштаб выгоды: отдельный knob (иначе 1e9 из priceTriggerPct утёк бы в него)
  execStyle: "limit",
  makerFeeRate: PERP_FEE,
  takerFeeRate: PERP_FEE, // закрытие перпа в экспирацию у бота 2 ВСЕГДА market; у эталона ставка одна
  slippageRate: 0.0002, // входит только в estimateCost, а тот при λ = 0 не решает
  fundingMaxGapSec: 1e9, // см. выше
  paperEquityUsd: DEPOSIT,
  qty: QTY_FIXED ?? LOT,
};
// БЛЭКАУТ РАСЧЁТА ЗДЕСЬ НАМЕРЕННО НЕ ВЫКЛЮЧЕН: в профиле он остаётся дефолтным `true`, и выключить
// его обязан сам движок веткой продавца. Если однажды перестанет - сверка это увидит, потому что
// экспирации Deribit наступают ровно в 08:00 UTC, то есть в самом окне блэкаута.
const sellCfg = {
  bandBtc: DROP === "band-off" ? 0 : BAND, // КОНТРОЛЬ band-off: полосы нет, хедж на каждом тике
  lot: LOT,
  execModel: "maker-mid",
};

// ── СБОРКА СНИМКА ИЗ ЗАПИСИ: ровно тот контракт, что отдаёт `buildDeribitSnapshot`.
// Цена ОТКРЫТОЙ ноги всегда идёт через лестницу `priceAt` (как у эталона), даже когда строка в
// снимке есть: иначе счётчик ступеней считал бы не то, чем считали.
function buildSnapshot(i, openLeg) {
  const ts = R.times[i];
  const S = R.spot[i];
  const snap = R.snaps.get(ts);
  const legs = {};
  const chain = [];
  for (const r of snap.values()) {
    if (!(r.m > 0)) continue;
    const name = r.n;
    chain.push({
      instrument_name: name, strike: r.k, expiration_timestamp: r.e,
      option_type: r.s === "C" ? "call" : "put", contract_size: 1, min_trade_amount: LOT, tick_size: 0.5,
    });
    legs[name] = {
      instrument: name, type: r.s === "C" ? "call" : "put", strike: r.k, expiryMs: r.e,
      bid: r.b, ask: r.a, mark: r.m, markIv: r.iv, delta: r.d, gamma: null, vega: r.vg, theta: r.th,
      underlying: S, index: S, contractSize: 1, tickSize: 0.5, minTradeAmount: LOT, markInUsd: true, ts,
    };
  }
  let gateOk = true;
  if (openLeg) {
    const p = countPrice(R.stats, priceAt({
      snapshot: snap, expiryRows: R.byExp.get(ts)?.get(openLeg.expiryMs),
      meta: { name: openLeg.instrument, expiryMs: openLeg.expiryMs, strikeUsd: openLeg.strike, type: "C" },
      tsMs: ts, spotAtExpiry: spotBefore(openLeg.expiryMs),
    }));
    if (!p) gateOk = false; // цена не вышла: движок обязан стоять, а не хеджить по выдумке
    else {
      const prev = legs[openLeg.instrument] ?? {};
      legs[openLeg.instrument] = {
        ...prev, instrument: openLeg.instrument, type: "call", strike: openLeg.strike,
        expiryMs: openLeg.expiryMs, mark: p.markUsd, delta: p.delta, markIv: p.ivPct,
        underlying: S, index: S, contractSize: 1, minTradeAmount: LOT, markInUsd: true, ts,
      };
    }
  }
  const perp = {
    instrument: "BTC-PERPETUAL", mark: S, index: S, bid: S, ask: S,
    funding8h: fundRate(ts) * 8, inverse: true, contractSize: PERP_CS, tickSize: 0.5, minTradeAmount: 10, ts,
  };
  return {
    ts, underlying: S, index: S, legs, perp,
    liquidity: { bid: S, ask: S, mid: S, halfSpread: 0 },
    fresh: { ageSec: 0, stale: false, ok: gateOk, gateOk, gateFailed: [], source: "replay", notes: [] },
    chain,
  };
}

// ── ЦЕПОЧКА. Закрылась сделка - со следующего снимка ищем новую. Ни пропусков, ни выбора момента:
// то же правило, что у эталона (`i = t.endIdx + 1`).
const st = s1engine.create({ nowMs: R.times[0], settings });
const book = [];
let open = null; // { leg, openIdx, openTs, sizing, accAtOpen }
let noOpen = 0, noSpot = 0, blockedOpen = new Map();
// ДИАГНОСТИКА БАЗЫ ФАНДИНГА. Эталон начисляет на дельта×спот, движок (`accrueFunding`) на номинал
// позиции qty·cs - то, на что фандинг начисляет БИРЖА. Тень считает эталонную базу на тех же тиках,
// чтобы расхождение столбца «фандинг» имело число, а не объяснение.
let shadowFund = 0, prevTs = null;
// СЧЁТЧИК НИЧЬИХ НА ПОЛОСЕ. Дельты записи округлены до 4 знаков, поэтому разрыв |нужный − текущий|
// регулярно ложится РОВНО на полосу, а сравнение в правиле строгое (`> band`). На такой ничьей
// решение определяется семнадцатым знаком, и любая независимая реализация вправе решить иначе.
let tickTies = 0, tickDecisions = 0;

const accOf = (state) => (state.perpState.fundingCum || 0);
const feesOf = (state) => (state.perpState.feesCum || 0);
const realPerpOf = (state) => (state.perpState.realizedUsd || 0);
const realOptOf = (state) => (state.realizedOptionsUsd || 0);

for (let i = 0; i < N; i++) {
  const S = R.spot[i];
  if (!(S > 0)) { noSpot += 1; continue; } // снимок без спота эталон пропускает целиком - и мы тоже
  const ts = R.times[i];
  const snapshot = buildSnapshot(i, open?.leg ?? null);

  if (st.perpState.qty !== 0 && prevTs != null) {
    const dBtc = st.perpState.avgEntry > 0 ? (st.perpState.qty * PERP_CS) / st.perpState.avgEntry : 0;
    shadowFund += -dBtc * S * fundRate(ts) * ((ts - prevTs) / 3600000);
  }
  prevTs = ts;
  s1engine.ingest(st, snapshot, ts);
  const hadStructure = !!st.structure;
  // ПЕРЕВХОД СПРАШИВАЕТСЯ У ПРАВИЛА, А НЕ РЕШАЕТСЯ ЗДЕСЬ. Прежде тут стояло `if (!hadStructure)`,
  // то есть цепочку строил САМ ДРАЙВЕР, и сверка книг доказывала свойство скрипта: в приложении эту
  // строку не исполняет никто, после экспирации позиция просто исчезала. Теперь условие приходит из
  // `sellhedge.js`, и тот же вызов делает боевой тракт. Порядок (до `evaluate`) - часть правила:
  // на тике экспирации структура ещё открыта, поэтому расчёт делает `evaluate` этого тика, а
  // следующая сделка открывается СЛЕДУЮЩИМ тиком, как `i = endIdx + 1` у эталона.
  if (shouldOpenNext({ hasStructure: hadStructure, chainOn: true, stopRequested: false })) {
    const before = st.ledger.length;
    const res = s1engine.openStructure(
      st,
      { kind: "sell-call", qty: DROP === "size-off" ? LOT : QTY_FIXED, execStyle: "limit",
        sellCfg: DROP === "pick-off" ? { ...sellCfg, deltaTarget: 0.30 } : sellCfg },
      snapshot.chain, snapshot, ts,
    );
    if (res.error) {
      noOpen += 1;
      blockedOpen.set(res.error.slice(0, 48), (blockedOpen.get(res.error.slice(0, 48)) ?? 0) + 1);
    } else {
      const l = res.structure.legs[0];
      open = {
        leg: { instrument: l.instrument, strike: l.strike, expiryMs: l.expiryMs },
        openIdx: i, openTs: ts, sizing: res.structure.sizing, qtyAbs: l.qtyAbs,
        entryMark: l.entryMark, entrySpot: S, entryCostUsd: res.structure.entryCostUsd,
        ledgerFrom: before,
        acc0: { fund: accOf(st), fees: feesOf(st), realPerp: realPerpOf(st), realOpt: realOptOf(st), shadow: shadowFund },
      };
    }
  }

  const cycle = s1engine.evaluate(st, snapshot, ts);

  if (st.structure) {
    tickDecisions += 1;
    const total = cycle.net_option_delta_bs + cycle.current_futures_delta;
    if (Math.abs(Math.abs(total) - (cycle.hedge_deadband_btc ?? 0)) < 1e-9) tickTies += 1;
  }

  // ДИАГНОСТИКА: поток решений первой сделки в тех же единицах, что у эталона (на 1.0 контракта).
  if (TRACE && book.length === TRACE_TRADE - 1 && st.structure) {
    const q = st.structure.legs[0].qtyAbs;
    TRACE.push([ts, snapshot.underlying, snapshot.legs[st.structure.legs[0].instrument]?.delta ?? "",
      cycle.target_futures_delta / q, cycle.current_futures_delta / q,
      cycle.decision === "HEDGE" ? "H" : "."].join("\t"));
  }

  // Экспирация закрыла структуру внутри evaluate - книжим строку и ждём СЛЕДУЮЩЕГО снимка.
  if (open && !st.structure) {
    const rows = st.ledger.slice(open.ledgerFrom);
    const hedges = rows.filter((r) => r.type === "hedge");
    const flat = rows.filter((r) => r.type === "close-perp");
    const settle = rows.find((r) => r.type === "settle-options");
    book.push({
      instrument: open.leg.instrument,
      openTs: open.openTs,
      closeTs: ts,
      lots: open.sizing?.lots ?? Math.round(open.qtyAbs / LOT),
      qty: open.qtyAbs,
      imUsd: (open.sizing?.imPerContract ?? 0) * open.qtyAbs,
      rehedges: hedges.length,
      turnoverBtc: hedges.reduce((a, r) => a + Math.abs(r.deltaBtc), 0),
      optLeg: settle?.realizedUsd ?? 0,
      hedgeLeg: realPerpOf(st) - open.acc0.realPerp,
      cost: (feesOf(st) - open.acc0.fees) + (open.entryCostUsd ?? 0),
      funding: accOf(st) - open.acc0.fund,
      fundingRefBase: shadowFund - open.acc0.shadow,
      entrySpot: open.entrySpot,
      exitSpot: S,
      strike: open.leg.strike,
      entryMark: open.entryMark,
      equityAtOpen: DEPOSIT + open.acc0.realPerp + open.acc0.realOpt + open.acc0.fund - open.acc0.fees,
      flatCount: flat.length,
    });
    for (const b of [book.at(-1)]) b.pnl = b.optLeg + b.hedgeLeg - b.cost + b.funding;
    open = null;
    if (DROP === "settle-late") i += 24; // КОНТРОЛЬ: выход на сутки позже - сверка обязана заметить
  }
  void cycle;
}

// ── КНИГА. Формат один на обе стороны (см. hist-sellhedge.mjs --book), чтобы сверка была diff.
const f = (x, d) => (fin(x) ? x.toFixed(d) : "н/д");
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const HEAD = ["#", "инструмент", "открыт", "закрыт", "лотов", "залог", "перекладок", "оборот BTC",
  "премия-выкуп", "хедж", "издержки", "фандинг", "итого"].join("\t");
const bookLine = (b, k) => [
  k + 1, b.instrument, iso(b.openTs), iso(b.closeTs), b.lots, f(b.imUsd, 2), b.rehedges,
  f(b.turnoverBtc, 6), f(b.optLeg, 2), f(b.hedgeLeg, 2), f(b.cost, 2), f(b.funding, 2), f(b.pnl, 2),
].join("\t");
const bookText = [HEAD, ...book.map(bookLine)].join("\n") + "\n";
if (argOf("--book")) writeFileSync(argOf("--book"), bookText);
if (TRACE) writeFileSync(argOf("--trace"), TRACE.join("\n") + "\n");

const sum = (k) => book.reduce((a, b) => a + b[k], 0);
const dt = (ms) => new Date(ms).toISOString().slice(0, 10);
console.log(`# Прогон записи через живой движок бота 2\n`);
console.log(`Запись ${DIR}: ${N} снимков, ${dt(R.times[0])} .. ${dt(R.times.at(-1))}.`);
console.log(`Депозит $${DEPOSIT} · размер ${QTY_FIXED ?? "от залога (lotsByMargin)"} · полоса ${BAND} BTC на контракт `
  + `· комиссия перпа ${(PERP_FEE * 1e4).toFixed(1)} б.п.${PERP_CS !== 10 ? ` · контракт перпа $${PERP_CS} (диагностика)` : ""}${DROP ? ` · КОНТРОЛЬ: заглушено правило ${DROP}` : ""}.`);
console.log(`Движок: openStructure(kind: "sell-call") зовёт pickSellLeg и lotsByMargin, evaluate зовёт decideHedge, applyFill и settleStructure.\n`);
console.log(`## Книга\n`);
console.log(`| величина | значение |`);
console.log(`|---|---|`);
console.log(`| сделок | **${book.length}** |`);
if (book.length) {
  console.log(`| первый вход / последний выход | ${dt(book[0].openTs)} / ${dt(book.at(-1).closeTs)} |`);
  console.log(`| прибыльных | ${book.filter((b) => b.pnl > 0).length} |`);
  console.log(`| перекладок всего | ${sum("rehedges")} |`);
  console.log(`| премия минус выкуп | ${f(sum("optLeg"), 2)} |`);
  console.log(`| хедж по перпу | ${f(sum("hedgeLeg"), 2)} |`);
  console.log(`| издержки | ${f(-sum("cost"), 2)} |`);
  console.log(`| фандинг | ${f(sum("funding"), 2)} |`);
  console.log(`| **итого** | **${f(sum("pnl"), 2)}** |`);
  const eq = DEPOSIT + sum("pnl");
  console.log(`| счёт | с $${DEPOSIT} до **$${f(eq, 2)}** (×${f(eq / DEPOSIT, 2)}) |`);
}
console.log(`\n## Снабжение\n`);
console.log(`- ${formatPriceStats(R.stats)}`);
console.log(`- снимков без спота пропущено: ${noSpot}`);
if (book.length) {
  const fe = sum("funding"), fr = book.reduce((a, b) => a + b.fundingRefBase, 0);
  console.log(`- фандинг: движок начисляет на НОМИНАЛ позиции (qty·cs, база биржи) ${f(fe, 2)}; на базе эталона`);
  console.log(`  (дельта × спот) вышло бы ${f(fr, 2)}, то есть в ${f(fe / fr, 4)} раза - это и есть весь столбец;`);
}
console.log(`- тиков решения ${tickDecisions}, из них разрыв РОВНО на полосе ${tickTies} `
  + `(${f((100 * tickTies) / Math.max(1, tickDecisions), 2)}%): дельты записи округлены до 4 знаков, а`);
console.log(`  сравнение строгое, поэтому на ничьей решение определяет последний разряд double;`);
console.log(`- снимков, где открыть не вышло: ${noOpen}`);
for (const [reason, n] of [...blockedOpen].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  console.log(`  - ${n} × ${reason}`);
}
if (has("--trades") && book.length) {
  console.log(`\n## Сделки\n`);
  console.log("```");
  console.log(bookText.trimEnd());
  console.log("```");
}
console.log(`\n## Границы прогона по записи\n`);
console.log(`- реального исполнения заявок нет: перп заполняется по споту записи, стакана перпа в записи НЕТ,`);
console.log(`  поэтому ни проскальзывание, ни глубина, ни отказ лимитной заявки не моделируются;`);
console.log(`- bid/ask опционов в записи МОДЕЛЬНЫЕ (синтетика из живого прогона), отсюда spreadScale 1.10;`);
console.log(`- комиссия биржи за расчёт опциона в деньгах не учтена ни одной стороной;`);
console.log(`- фандинг берётся почасовой ставкой кэша, внутричасовой профиль не моделируется;`);
console.log(`- сеть, таймауты, деградация источника и рестарты приложения прогоном не затрагиваются вовсе.`);
