// otmscan-sellhedge.test.js - правила продажи опциона с дельта-хеджем (sellhedge.js).
// Проверяется прежде всего то, ради чего модуль заведён: схема НЕ ВЫХОДИТ досрочно ни по какому
// поводу, размер считается от ЗАЛОГА, а не от премии, и перекладка решается ПОЛОСОЙ, а не частотой.

import test from "node:test";
import assert from "node:assert/strict";
import {
  SELLHEDGE_DEFAULTS, pickSellLeg, openSellTrade, halfSpreadUsd, wantHedge, shouldRehedge,
  walkSellTrade, settleSellTrade, lotsByMargin, usdDeltaOfInversePerp, sellhedgeEngineCfg, shouldOpenNext,
  rankSellLegs, shouldOpenDegraded, sellerZone, stepMtm, shouldStopOut, makeStopGate, makeStopAt, liveSellStop,
} from "../src/engine/otmscan/sellhedge.js";
import { markPerp } from "../src/engine/btcopt/pnl.js";
import { effectiveDeadband } from "../src/engine/btcopt/hedge.js";
import { near } from "./otmscan-helpers.mjs";

const C = SELLHEDGE_DEFAULTS;
// Строка поверхности: h часов до экспирации, s тип, m марк, d дельта, b/a бид/аск, iv, vg вега.
const row = (over = {}) => ({ n: "BTC-1JAN26-100000-C", e: 0, k: 100000, s: "C", h: 480,
  m: 3000, d: 0.45, b: 2950, a: 3050, iv: 45, vg: 120, ...over });

// ── выбор ноги
test("нога: берётся колл с |дельтой| ближе всего к целевой", () => {
  const rows = [row({ n: "far", d: 0.30 }), row({ n: "hit", d: 0.47 }), row({ n: "mid", d: 0.53 })];
  assert.equal(pickSellLeg(rows, C).n, "hit");
});

test("нога: дефолтное правило берёт только коллы - боевая схема продаёт колл", () => {
  assert.equal(pickSellLeg([row({ s: "P", d: -0.45 })], C), null);
});

test("нога: legType «P» переключает правило на путы, отсутствующее поле остаётся коллом", () => {
  const rows = [row({ n: "call", d: 0.45 }), row({ n: "put", s: "P", d: -0.45 })];
  assert.equal(pickSellLeg(rows, C).n, "call", "без поля - колл: старые вызывающие правок не требуют");
  assert.equal(pickSellLeg(rows, { ...C, legType: "P" }).n, "put", "близость меряется |дельтой|, знак пута не мешает");
  assert.equal(pickSellLeg([row({ n: "call" })], { ...C, legType: "P" }), null, "колл путовому правилу не нога");
});

test("нога: срок вне окна отвергается по обеим границам", () => {
  assert.equal(pickSellLeg([row({ h: C.expiryMinH - 1 })], C), null);
  assert.equal(pickSellLeg([row({ h: C.expiryMaxH + 1 })], C), null);
  assert.equal(pickSellLeg([row({ h: C.expiryMinH })], C)?.h, C.expiryMinH);
  assert.equal(pickSellLeg([row({ h: C.expiryMaxH })], C)?.h, C.expiryMaxH);
});

test("нога: строка без полей расчёта не берётся - оценка вместо наблюдения запрещена", () => {
  for (const gap of [{ m: 0 }, { d: null }, { b: null }, { a: null }, { iv: null }, { vg: null }]) {
    assert.equal(pickSellLeg([row(gap)], C), null, `пропуск ${JSON.stringify(gap)}`);
  }
});

// Границы допуска берутся ДВОИЧНО ТОЧНЫМИ числами (0.5 / 0.25 / 0.75), а не 0.45 ± 0.10: на
// десятичных дробях |0.55 − 0.45| даёт 0.10000000000000003 и «ровно на границе» недостижимо в
// принципе. Это свойство плавающей точки, а не правила, и подменять им проверку правила нельзя.
test("нога: дальше допуска дельты - null, а не «лучшее из плохого»", () => {
  const E = { ...C, deltaTarget: 0.5, deltaTol: 0.25 };
  assert.equal(pickSellLeg([row({ d: 0.75 })], E)?.d, 0.75, "ровно на границе допуска берём");
  assert.equal(pickSellLeg([row({ d: 0.8 })], E), null, "за границей не берём ничего");
});

// ── вход
test("вход: платится ПОЛОВИНА круга - опцион гасится сам, книгу второй раз не пересекаем", () => {
  const leg = row();
  const costs = { roundTripCostPct: 4 };
  const o = openSellTrade({ leg, spotUsd: 100000, costs, imUsd: 9000, cfg: C });
  near(o.optCost, (4 / 100) * leg.m / 2, 1e-12, "половина круга от премии");
  assert.equal(o.premSold, leg.m, "без вычета воли продаём по марку");
  assert.equal(o.qPerp, leg.d, "начальный хедж равен дельте проданного колла");
  assert.equal(o.hedgeFee, 0, "мейкерский перп бесплатен по умолчанию");
});

test("вход: вычет воли снимает vg × пунктов с премии", () => {
  const leg = row();
  const o = openSellTrade({ leg, spotUsd: 100000, costs: { roundTripCostPct: 4 }, imUsd: 9000,
    cfg: { ...C, ivHaircut: 0.5 } });
  near(o.premSold, leg.m - leg.vg * 0.5, 1e-12, "премия ниже марка на вегу × пункты");
});

test("вход: комиссия перпа берётся с оборота начального хеджа", () => {
  const o = openSellTrade({ leg: row(), spotUsd: 100000, costs: { roundTripCostPct: 4 },
    imUsd: 9000, cfg: { ...C, perpFee: 0.0005 } });
  near(o.hedgeFee, 0.45 * 100000 * 0.0005, 1e-9, "|дельта| × спот × ставка");
});

test("половина спреда умножается на допущение spreadScale и это видно снаружи", () => {
  near(halfSpreadUsd(row(), C), 50 * 1.10, 1e-12);
  near(halfSpreadUsd(row(), { ...C, spreadScale: 1 }), 50, 1e-12);
});

// ── хедж
// Числа снова двоично точные: на 0.45/0.03 разность даёт 0.030000000000000027, то есть «ровно
// полоса» на десятичных дробях не существует и проверялось бы поведение float, а не правила.
test("перекладка решается полосой и порог СТРОГИЙ: ровно на границе не перекладываемся", () => {
  assert.equal(shouldRehedge({ want: 0.75, have: 0.5, bandBtc: 0.25 }), false, "вверх ровно полоса");
  assert.equal(shouldRehedge({ want: 0.25, have: 0.5, bandBtc: 0.25 }), false, "вниз ровно полоса");
  assert.equal(shouldRehedge({ want: 0.875, have: 0.5, bandBtc: 0.25 }), true, "вверх за полосой");
  assert.equal(shouldRehedge({ want: 0.125, have: 0.5, bandBtc: 0.25 }), true, "вниз за полосой");
});

test("нужный хедж это дельта позиции, неизвестная дельта даёт ноль, а не догадку", () => {
  assert.equal(wantHedge(0.37), 0.37);
  assert.equal(wantHedge(null), 0);
  assert.equal(wantHedge(NaN), 0);
});

// ── протяжка
// Каркас: N шагов по часу, спот и дельта задаются функциями, экспирация на последнем шаге.
const walk = ({ steps, spot, delta, expiryAt = steps - 1, price = () => ({}), cfg = C, fund = 0 }) => {
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  return walkSellTrade({
    count: steps,
    tsAt: (k) => T0 + (k + 1) * 3600000,
    spotAt: (k) => spot(k),
    priceAt: (k) => ({ markUsd: 100, delta: delta(k), ...price(k) }),
    fundRateAt: () => fund,
    expiryMs: T0 + (expiryAt + 1) * 3600000,
    entry: { qPerp: 0.45, hedgeFee: 0 },
    entryTsMs: T0, entrySpot: 100000, cfg,
  });
};

test("протяжка: НИ ОДНОГО досрочного выхода - ни на обвале премии, ни на взлёте", () => {
  const r = walk({ steps: 10, spot: (k) => 100000 * (1 + 0.05 * k), delta: () => 0.45,
    price: (k) => ({ markUsd: k === 3 ? 10000 : k === 6 ? 1 : 100 }) });
  assert.equal(r.exitIndex, 9, "вышли ровно в экспирацию, а не на тейке или стопе");
  assert.equal(r.exitVal, 100);
});

test("протяжка: снимок без спота пропускается целиком - ни P&L, ни фандинга, ни цены", () => {
  let priced = 0;
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  const r = walkSellTrade({
    count: 3,
    tsAt: (k) => T0 + (k + 1) * 3600000,
    spotAt: (k) => (k === 0 ? null : 110000),
    priceAt: () => { priced += 1; return { markUsd: 100, delta: 0.45 }; },
    fundRateAt: () => 0,
    expiryMs: T0 + 3 * 3600000,
    entry: { qPerp: 1, hedgeFee: 0 }, entryTsMs: T0, entrySpot: 100000, cfg: C,
  });
  assert.equal(priced, 2, "лестница цены на снимке без спота НЕ вызывается");
  near(r.hedgePnl, 10000, 1e-9, "P&L считается от входа к первому валидному споту, без разрывов");
});

test("протяжка: цена не вышла - сделка не засчитывается, а не оценивается наугад", () => {
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  const r = walkSellTrade({
    count: 3,
    tsAt: (k) => T0 + (k + 1) * 3600000,
    spotAt: () => 100000,
    priceAt: (k) => (k === 1 ? null : { markUsd: 100, delta: 0.45 }),
    fundRateAt: () => 0,
    expiryMs: T0 + 3 * 3600000,
    entry: { qPerp: 0.45, hedgeFee: 0 }, entryTsMs: T0, entrySpot: 100000, cfg: C,
  });
  assert.equal(r, null);
});

test("протяжка: перекладки считаются, вход в хедж это уже одна поправка", () => {
  const flat = walk({ steps: 5, spot: () => 100000, delta: () => 0.45 });
  assert.equal(flat.rehedges, 1, "дельта не двигалась - только вход");
  // Шаг 0 повторяет дельту входа (разрыв 0), шаги 1-3 уходят за полосу, шаг 4 это ЭКСПИРАЦИЯ и
  // выходит из цикла ДО проверки хеджа: перекладываться в момент гашения бессмысленно.
  const moved = walk({ steps: 5, spot: () => 100000, delta: (k) => 0.45 + 0.05 * k });
  assert.equal(moved.rehedges, 4, "вход плюс три поправки, в экспирацию не перекладываемся");
});

test("протяжка: P&L хеджа линеен по споту при неизменной позиции", () => {
  const r = walk({ steps: 3, spot: (k) => 100000 + 1000 * (k + 1), delta: () => 0.45 });
  near(r.hedgePnl, 0.45 * 3000, 1e-9, "0.45 BTC × движение 3000");
});

test("протяжка: фандинг платит ЛОНГ перпа при положительной ставке", () => {
  const r = walk({ steps: 3, spot: () => 100000, delta: () => 0.45, fund: 0.00001 });
  assert.ok(r.funding > 0, "положительный фандинг это расход лонга");
  near(r.funding, 0.45 * 100000 * 0.00001 * 3, 1e-9, "часовая ставка × три часа");
});

// ── итог сделки
test("итог: поправка цепочки множит ИТОГ, а не отдельные статьи", () => {
  const open = { premSold: 3000, optCost: 60, imUsd: 9000, qPerp: 0.45, hedgeFee: 0 };
  const w = { exitVal: 2000, exitIndex: 9, hedgePnl: 500, hedgeFee: 10, funding: 40, rehedges: 7 };
  const a = settleSellTrade({ open, walk: w, cfg: C });
  const b = settleSellTrade({ open, walk: w, cfg: { ...C, chainAdj: 0.69 } });
  near(a.pnl, (1000 + 500 - 70 - 40), 1e-9);
  near(b.pnl, a.pnl * 0.69, 1e-9);
  assert.equal(a.optLeg, b.optLeg, "статьи разложения поправкой не трогаются");
  assert.equal(a.cost, 70, "издержки это вход в опцион плюс комиссии хеджа");
});

// ── долларовая дельта обратного перпа
test("долларовая дельта обратного перпа считается от avgEntry и по цене НЕ уплывает", () => {
  // Длинная позиция $60 000 номинала, вход 60 000: долларовая дельта ровно 1.0 BTC.
  const pos = { qty: 6000, contractSize: 10, avgEntry: 60000 };
  near(usdDeltaOfInversePerp(pos), 1.0, 1e-12, "на входе");
  // Цена ушла на +10%: долларовая дельта ОБЯЗАНА остаться 1.0. Проверяется прямым P&L, а не
  // повтором формулы: спот-позиция 1.0 BTC дала бы ровно те же $6000.
  const uplUsd = pos.qty * pos.contractSize * (66000 - pos.avgEntry) / pos.avgEntry;
  near(uplUsd, 6000, 1e-9, "P&L обратной позиции равен P&L одного BTC спота");
  near(usdDeltaOfInversePerp(pos), uplUsd / (66000 - 60000), 1e-12, "дельта = P&L / движение");
});

// СВЯЗЬ ДВУХ МОДУЛЕЙ, а не дубль расчёта: продавец и хедж бота 2 обязаны считать дельту ОДНОЙ
// конвенцией, иначе перенос схемы в бой снова разъедется. Тест зовёт настоящий markPerp, поэтому
// смена конвенции в боте 2 уронит его здесь, а не в бою.
test("продавец и бот 2 считают долларовую дельту перпа ОДИНАКОВО", () => {
  const pos = { qty: 6000, contractSize: 10, avgEntry: 60000 };
  const m = markPerp({ qty: pos.qty, avgEntry: pos.avgEntry }, { mark: 66000, contractSize: 10 });
  near(usdDeltaOfInversePerp(pos), m.futuresDeltaBtc, 1e-12, "одна конвенция на два модуля");
  near(m.futuresNotionalBtc, 60000 / 66000, 1e-9, "номинал остаётся отдельным числом");
  // Зазор 0.09 BTC на дельте 1.0 - ВТРОЕ шире рабочей полосы 0.03: подстановка номинала в проверку
  // нейтральности возвращает направленную ставку, а не даёт мелкую погрешность.
  assert.ok(m.futuresDeltaBtc - m.futuresNotionalBtc > 3 * SELLHEDGE_DEFAULTS.bandBtc);
});

test("плоская позиция даёт ноль, а не NaN: applyFill обнуляет avgEntry вместе с qty", () => {
  assert.equal(usdDeltaOfInversePerp({ qty: 0, contractSize: 10, avgEntry: 0 }), 0);
  assert.equal(usdDeltaOfInversePerp({ qty: 100, contractSize: 10, avgEntry: 0 }), 0);
  assert.equal(usdDeltaOfInversePerp({}), 0);
});

// ── размер
test("размер: считается от ЗАЛОГА и режется ВНИЗ, остаток счёта не повод округлить вверх", () => {
  const r = lotsByMargin({ imUsdPerContract: 9000, equityUsd: 500, cfg: C });
  assert.equal(r.imLotUsd, 90, "залог за минимальный лот");
  assert.equal(r.lots, 3, "500 × 0.70 / 90 = 3.88 лота, берём 3");
  near(r.imUsedUsd, 270, 1e-12);
});

test("размер: лот не влезает в потолок развёртывания - ноль лотов, а не один", () => {
  assert.equal(lotsByMargin({ imUsdPerContract: 16000, equityUsd: 100, cfg: C }).lots, 0);
});

test("размер продавца НЕ равен размеру покупателя: залог за лот кратно выше премии", () => {
  // Числа с пятилетней записи: медиана залога $92 за лот против премии $21.91.
  const byMargin = lotsByMargin({ imUsdPerContract: 9200, equityUsd: 500, cfg: C }).lots;
  const byPremium = Math.floor((500 * 0.20) / (2191 * 0.01)); // риск 20% депозита от премии
  assert.ok(byPremium > byMargin, `премия дала бы ${byPremium} лотов против ${byMargin} по залогу`);
});

// ── настройки движка и перевход
// Обе группы существуют затем, чтобы измеренная конфигурация и правило цепочки жили в КОДЕ, а не
// внутри офлайн-скрипта: пока они жили там, сверка книг доказывала свойство скрипта, а живой бот с
// профилем по умолчанию давал ×24.2 вместо ×46.5 и одну сделку вместо семнадцати.

test("настройки движка: полоса схемы якорится на КОНТРАКТ, а не на калибровочный размер", () => {
  const c = sellhedgeEngineCfg(C);
  assert.equal(c.deadbandBtc, C.bandBtc, "полоса берётся из правила схемы");
  assert.equal(c.deadbandRefQty, 1.0, "якорь 1.0 = полоса задана на контракт");
  // effectiveDeadband(полоса, размер, якорь) = полоса·размер/якорь. Позиция в q контрактов обязана
  // получить ровно bandBtc·q, то есть то же число, каким мерил эталон.
  for (const q of [0.01, 0.1, 1, 5]) {
    near(effectiveDeadband({ deadbandBtc: c.deadbandBtc, structureQty: q, refQty: c.deadbandRefQty }),
      C.bandBtc * q, 1e-15);
  }
});

test("настройки движка: все три добавки решения выключены, у схемы одно правило перекладки", () => {
  const c = sellhedgeEngineCfg(C);
  assert.equal(c.lambda, 0, "гейт выгоды вырождается в benefit > 0");
  assert.ok(c.priceTriggerPct >= 1e9, "триггер цены недостижим");
  assert.ok(c.rehedgeSec >= 1e9, "триггер времени недостижим");
  assert.equal(c.settlementBlackout, false, "у схемы нет выходных у хеджа");
});

test("настройки движка: полоса следует за перекрытием sellCfg, а не за константой", () => {
  assert.equal(sellhedgeEngineCfg({ ...C, bandBtc: 0.08 }).deadbandBtc, 0.08);
});

test("перевход: открываем, только когда цепочка включена и структуры нет", () => {
  const on = { chainOn: true, stopRequested: false };
  assert.equal(shouldOpenNext({ ...on, hasStructure: false }), true, "плоско и цепочка идёт");
  assert.equal(shouldOpenNext({ ...on, hasStructure: true }), false, "сделка уже открыта");
  assert.equal(shouldOpenNext({ chainOn: false, hasStructure: false }), false, "одноразовый режим");
});

test("перевход: остановка оператора не закрывает сделку, но следующей не будет", () => {
  const stop = { chainOn: true, stopRequested: true };
  assert.equal(shouldOpenNext({ ...stop, hasStructure: true }), false, "текущая доживает до экспирации");
  assert.equal(shouldOpenNext({ ...stop, hasStructure: false }), false, "и следующая не открывается");
});

test("перевход: спрашивается ДО расчёта, поэтому на тике экспирации не срабатывает", () => {
  // На тике экспирации структура ещё открыта (settleStructure зовётся внутри evaluate ПОСЛЕ этого
  // вопроса), значит новая сделка не может открыться той же меткой, что и расчёт старой. Ровно так
  // же считает эталон: следующая сделка начинается с индекса endIdx + 1.
  assert.equal(shouldOpenNext({ hasStructure: true, chainOn: true, stopRequested: false }), false);
});

test("перевход: режим «одна сделка» не переоткрывает после первой закрытой", () => {
  const on = { chainOn: true, stopRequested: false, hasStructure: false, mode: "once" };
  assert.equal(shouldOpenNext({ ...on, tradesCount: 0 }), true, "первая сделка открывается");
  assert.equal(shouldOpenNext({ ...on, tradesCount: 1 }), false, "вторая уже нет");
  // Отсутствующее поле mode читается как непрерывный режим: старые вызывающие правок не требуют.
  assert.equal(shouldOpenNext({ chainOn: true, stopRequested: false, hasStructure: false, tradesCount: 5 }), true);
});

// ── ранжирование кандидатов для санитарии
test("кандидаты: rankSellLegs отдаёт очередь в порядке близости дельты и режет по допуску", () => {
  const rows = [row({ n: "far", d: 0.36 }), row({ n: "hit", d: 0.47 }), row({ n: "mid", d: 0.53 }),
    row({ n: "out", d: 0.70 })]; // 0.70 вне допуска 0.45±0.10, остальные внутри
  const ranked = rankSellLegs(rows, C, 3);
  assert.deepEqual(ranked.map((r) => r.n), ["hit", "mid", "far"]);
  assert.equal(rankSellLegs(rows, C, 10).length, 3, "вне допуска в очередь не попадает");
});

test("кандидаты: pickSellLeg остался топ-1 ранжирования - поведение прежнее", () => {
  const rows = [row({ n: "far", d: 0.30 }), row({ n: "hit", d: 0.47 })];
  assert.equal(pickSellLeg(rows, C).n, rankSellLegs(rows, C, 1)[0].n);
  assert.equal(pickSellLeg([row({ d: 0.70 })], C), null, "лучший вне допуска по-прежнему null");
});

test("ожидание санитарии: окно истекает ровно на границе", () => {
  const t0 = 1_000_000;
  const win = 4 * 3600000;
  assert.equal(shouldOpenDegraded({ sanityWaitingSince: t0, nowMs: t0 + win - 1, windowMs: win }), false);
  assert.equal(shouldOpenDegraded({ sanityWaitingSince: t0, nowMs: t0 + win, windowMs: win }), true);
  assert.equal(shouldOpenDegraded({ sanityWaitingSince: null, nowMs: t0, windowMs: win }), false, "без начала ожидания не деградируем");
});

// ── ЗОНА ПРОДАВЦА. Правило одно на проект: чип живого сканера и столбец книги офлайн-отчёта зовут
// эту функцию, поэтому «худшая зона» в интерфейсе и в отчёте обязаны означать ровно одно.
test("зона: RV7d выше IV ноги - худшая, иначе обычная", () => {
  assert.equal(sellerZone({ ivPct: 40, rv7dPct: 55 }), "worst");
  assert.equal(sellerZone({ ivPct: 55, rv7dPct: 40 }), "normal");
});

test("зона: равенство относится к обычной - граница у строгого «выше»", () => {
  assert.equal(sellerZone({ ivPct: 50, rv7dPct: 50 }), "normal");
});

test("зона: нет данных - null, а не «обычная»", () => {
  // Начало записи: RV7d ещё не набрал недельное окно. Зачислить такие сделки в благополучную зону
  // значило бы записать разогрев в хороший режим просто потому, что мерить было нечем.
  assert.equal(sellerZone({ ivPct: 50, rv7dPct: null }), null);
  assert.equal(sellerZone({ ivPct: null, rv7dPct: 50 }), null);
  assert.equal(sellerZone({ ivPct: 50, rv7dPct: NaN }), null);
  assert.equal(sellerZone(), null);
});

// ── наблюдатель шага (ревизия 2026-08-25 Р2: маржинальный путь и режим ликвидации эталона)
test("протяжка: onStep видит каждый оценённый шаг и НЕ меняет итог ни на бит", () => {
  const seen = [];
  const base = walk({ steps: 5, spot: (k) => 100000 + 1000 * k, delta: (k) => 0.45 + 0.05 * k });
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  const observed = walkSellTrade({
    count: 5,
    tsAt: (k) => T0 + (k + 1) * 3600000,
    spotAt: (k) => 100000 + 1000 * k,
    priceAt: (k) => ({ markUsd: 100, delta: 0.45 + 0.05 * k }),
    fundRateAt: () => 0,
    expiryMs: T0 + 5 * 3600000,
    entry: { qPerp: 0.45, hedgeFee: 0 }, entryTsMs: T0, entrySpot: 100000, cfg: C,
    onStep: (s) => seen.push(s),
  });
  assert.deepEqual(observed, base, "наблюдатель ничего не меняет");
  assert.equal(seen.length, 5, "каждый оценённый шаг виден, включая экспирационный");
  assert.equal(seen.at(-1).atExpiry, true, "последний шаг помечен экспирацией");
  assert.equal(seen[0].qPerp, 0.45, "позиция ДО перекладки шага");
  assert.equal(seen[1].qPerp, 0.45, "шаг 0 дельту не сдвинул (разрыв в полосе)");
  near(seen[1].hedgePnl, 0.45 * 1000, 1e-9, "накопители на момент наблюдения");
  assert.ok(seen.every((s) => s.mark === 100 && s.S > 0 && Number.isFinite(s.funding)), "поля шага");
});

// ── МтМ шага: одна формула на режим ликвидации эталона и офлайн-оценщик, а не по копии в каждом.
test("stepMtm: конвенция settleSellTrade; на экспирационном шаге при бесплатном перпе равен итогу", () => {
  const seen = [];
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  const open = { premSold: 3000, optCost: 60, imUsd: 9000, qPerp: 0.45, hedgeFee: 0 };
  const w = walkSellTrade({
    count: 5,
    tsAt: (k) => T0 + (k + 1) * 3600000,
    spotAt: (k) => 100000 + 2000 * k,
    priceAt: (k) => ({ markUsd: 2000 + 100 * k, delta: 0.45 + 0.05 * k }),
    fundRateAt: () => 0.00001,
    expiryMs: T0 + 5 * 3600000,
    entry: open, entryTsMs: T0, entrySpot: 100000, cfg: C,
    onStep: (s) => seen.push(s),
  });
  const settle = settleSellTrade({ open, walk: w, cfg: C });
  near(stepMtm({ premSold: open.premSold, optCost: open.optCost, step: seen.at(-1), cfg: C }),
    settle.pnl, 1e-9, "перп мейкерский: закрытие после цикла бесплатно, шаг экспирации и есть итог");
  // Поправка цепочки множит МтМ шага так же, как итог: одна конвенция, не вторая.
  near(stepMtm({ premSold: open.premSold, optCost: open.optCost, step: seen[0], cfg: { ...C, chainAdj: 0.69 } }),
    stepMtm({ premSold: open.premSold, optCost: open.optCost, step: seen[0], cfg: C }) * 0.69, 1e-12);
  assert.equal(stepMtm({ premSold: 3000, optCost: 60, step: null, cfg: C }), null, "нет шага - нет оценки");
});

// ── ДОСРОЧНЫЙ ВЫХОД (замер предложения заказчика, предрегистрация 2026-08-28).
// Главный инвариант этого блока: при выключенном правиле протяжка обязана вести себя ровно как
// раньше, и это проверяется не рассуждением, а полями возврата.
const walkStop = ({ steps = 10, mark = () => 100, stopAt, premSold = 300, expiryAt = steps - 1 } = {}) => {
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  return walkSellTrade({
    count: steps,
    tsAt: (k) => T0 + (k + 1) * 3600000,
    spotAt: () => 100000,
    priceAt: (k) => ({ markUsd: mark(k), delta: 0.45 }),
    fundRateAt: () => 0,
    expiryMs: T0 + (expiryAt + 1) * 3600000,
    entry: { qPerp: 0.45, hedgeFee: 0, premSold },
    entryTsMs: T0, entrySpot: 100000, cfg: C,
    stopAt,
  });
};

test("стоп выключен: протяжка не несёт ни поправки опционной ноги, ни издержек выхода", () => {
  const r = walkStop({});
  assert.equal(r.stopped, false);
  assert.equal(r.optLegOverride, null, "без стопа итог обязан считаться прежней формулой");
  assert.equal(r.stopCost, 0);
  assert.equal(r.exitIndex, 9);
});

test("предикат: каждая из пяти метрик отвечает по своей величине", () => {
  const base = { mtm1: -100, premSold: 200, imUsd: 500, equityUsd: 1, qty: 0.002, spotUsd: 100000,
    strikes: [{ type: "C", strike: 100000 }] };
  assert.equal(shouldStopOut({ ...base, metric: "premx", level: 0.5 }), true, "убыток = 0.5 премии");
  assert.equal(shouldStopOut({ ...base, metric: "premx", level: 0.6 }), false);
  assert.equal(shouldStopOut({ ...base, metric: "im", level: 0.2 }), true, "убыток = 0.2 залога");
  assert.equal(shouldStopOut({ ...base, metric: "im", level: 0.3 }), false);
  assert.equal(shouldStopOut({ ...base, metric: "eq", level: 0.2 }), true, "0.2 счёта при qty 0.002");
  assert.equal(shouldStopOut({ ...base, metric: "eq", level: 0.3 }), false);
  // Экспозиция: спот РОВНО на страйке это ещё не пробой при уровне 0.03.
  assert.equal(shouldStopOut({ ...base, metric: "mny", level: 0.03 }), false);
  assert.equal(shouldStopOut({ ...base, metric: "mny", level: 0, spotUsd: 100001 }), true);
  // Пут срабатывает вниз тем же кодом, а не зеркальной веткой у вызывающего.
  assert.equal(shouldStopOut({ ...base, metric: "mny", level: 0.05, spotUsd: 94000,
    strikes: [{ type: "P", strike: 100000 }] }), true);
  // Утилизация: mm·qty / (счёт + mtm·qty) = 400·0.002 / (1 − 0.2) = 1.0
  assert.equal(shouldStopOut({ ...base, metric: "mmu", level: 0.99, mmUsd: 400 }), true);
  assert.equal(shouldStopOut({ ...base, metric: "mmu", level: 1.01, mmUsd: 400 }), false);
  assert.equal(shouldStopOut({ metric: "premx", level: 1 }), false, "без величин - молчание, не догадка");
});

test("затвор: oneshot один раз за сделку, band требует двух шагов подряд", () => {
  const one = makeStopGate({ metric: "premx", level: 1, action: "exit", hyst: "oneshot" });
  assert.equal(one(true), "exit");
  assert.equal(one(true), null, "второй раз за сделку не срабатывает");
  const band = makeStopGate({ metric: "premx", level: 1, action: "exit", hyst: "band" });
  assert.equal(band(true), null, "одиночный выброс часовой сетки не считается");
  assert.equal(band(false), null);
  assert.equal(band(true), null, "счётчик подряд идущих сброшен возвратом");
  assert.equal(band(true), "exit");
});

test("затвор: fill next откладывает действие ровно на один шаг", () => {
  const g = makeStopGate({ metric: "premx", level: 1, action: "exit", hyst: "oneshot", fill: "next" });
  assert.equal(g(true), null, "на шаге пробоя ещё не выходим");
  assert.equal(g(false), "exit", "выходим по цене СЛЕДУЮЩЕГО шага");
});

test("затвор: rearm возвращает размер после ухода метрики и снова вооружается", () => {
  const g = makeStopGate({ metric: "premx", level: 1, action: "halve", hyst: "rearm" });
  assert.equal(g(true), "halve");
  assert.equal(g(true), null, "пока метрика за порогом, ничего не делаем");
  assert.equal(g(false, true), "restore", "метрика вернулась - восстанавливаем размер");
  assert.equal(g(true), "halve", "правило перевооружено");
});

test("протяжка: выход ровно на первом шаге, где предикат истинен", () => {
  const r = walkStop({ mark: (k) => (k === 2 ? 500 : 100),
    stopAt: (ctx) => (ctx.k === 2 ? { action: "exit", costUsd: 10 } : null) });
  assert.equal(r.stopped, true);
  assert.equal(r.exitIndex, 2, "вышли на шаге пробоя, а не в экспирацию");
  assert.equal(r.exitVal, 500);
  assert.equal(r.stopCost, 10);
  assert.equal(r.optLegOverride, 300 - 500, "опционная нога зафиксирована по марку выхода");
});

test("протяжка: урезание вдвое оставляет половину до экспирации и её тету", () => {
  const r = walkStop({ mark: (k) => (k === 2 ? 500 : 100),
    stopAt: (ctx) => (ctx.k === 2 ? { action: "halve", costUsd: 10 } : null) });
  assert.equal(r.stopped, true);
  assert.equal(r.exitIndex, 9, "половина позиции досидела до экспирации");
  assert.equal(r.scale, 0.5);
  assert.equal(r.stopCost, 5, "издержки выхода платятся с ПОЛОВИНЫ");
  // 0.5·(300 − 500) зафиксировано на стопе плюс 0.5·(300 − 100) досижено до экспирации.
  near(r.optLegOverride, 0.5 * (300 - 500) + 0.5 * (300 - 100), 1e-9);
});

test("расчёт сделки: со стопом издержки выхода добавляются РОВНО один раз", () => {
  const walk = walkStop({ mark: (k) => (k === 2 ? 500 : 100),
    stopAt: (ctx) => (ctx.k === 2 ? { action: "exit", costUsd: 10 } : null) });
  const open = { premSold: 300, optCost: 7, imUsd: 1000, qPerp: 0.45, hedgeFee: 0 };
  const s = settleSellTrade({ open, walk, cfg: C });
  near(s.cost, 7 + walk.hedgeFee + 10, 1e-9);
  near(s.optLeg, -200, 1e-9);
});

test("склейка: makeStopAt не строится без правила и без залога", () => {
  assert.equal(makeStopAt({ stop: null, imUsd: 100, deployPct: 0.7 }), undefined);
  assert.equal(makeStopAt({ stop: { metric: "premx", level: 1, action: "exit" }, deployPct: 0.7 }), undefined);
});

test("боевое правило выхода вооружается кодом и считается от потолка размера", () => {
  const r = liveSellStop(C);
  assert.equal(r.metric, "mmu", "выигравшая метрика замера это утилизация маржи, а не убыток");
  assert.equal(r.level, 0.6, "0.75 от потолка 0.8 = уровень 0.60, замеренная клетка");
  assert.equal(r.action, "exit");
  assert.equal(r.hyst, "band", "два часа подряд: одиночный выброс не закрывает сделку");
});

test("правило выхода едет за потолком размера, а не живёт от него отдельно", () => {
  assert.equal(liveSellStop({ ...C, stressCapFrac: 0.6 }).level, 0.45);
  assert.equal(liveSellStop({ ...C, stressCapFrac: 1.0 }).level, 0.75);
});

test("явное перекрытие правила выхода побеждает: замеру нужна своя клетка", () => {
  const mine = { metric: "premx", level: 2, action: "exit", hyst: "oneshot", fill: "same" };
  assert.deepEqual(liveSellStop({ ...C, stop: mine }), mine);
});

test("офлайн-дефолт схемы остаётся БЕЗ правила выхода: книги сверок сняты им", () => {
  assert.equal(C.stop, null, "выключенный дефолт - якорь пятилетних книг");
});
