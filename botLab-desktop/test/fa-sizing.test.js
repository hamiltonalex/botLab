// fa-sizing.test.js - ПРАВИЛО РАЗМЕРА ВХОДА БОТА 1 (fa/sizing.js): шесть ограничений спецификации,
// потолок тикета, сжатие к единому размеру, отбор рынка по окупаемости круга и лестница отказов.
//
// ОРАКУЛ, А НЕ ПЕРЕПРОВЕРКА КОДА СОБОЙ. Рынок с ПОСТОЯННЫМ потоком и без ноги Hyperliquid имеет
// нетто в замкнутом виде:
//     net(S) = P * S / (B + S) - k * S - газ,  где P это весь поток окна в долларах,
//     B база нашей стороны, k = 0.31% круга, газ = $1;
//     максимум при S* = sqrt(P * B / k) - B.
// Оба выражения выведены из формулы разбавления и модели издержек, а не сняты с работающего кода,
// поэтому проверки ниже сравнивают модуль с НЕЗАВИСИМЫМ числом. Там, где рынок непостоянный
// (проверка взвешенной базы), оракулом служит прямой счёт по определению.
//
// ДАННЫЕ СТРОИТ КОНСТРУКТОР `hour()` ИЗ `fa-helpers.mjs`: тождество `|f_long|*B_long =
// |f_short|*B_short` выполняется по построению, и нарушить его в тесте нельзя. Рынка, где обе
// стороны котируют одну ставку при разных базах, не существует, и тест на таком рынке проверял бы
// не правило, а собственную выдумку.
//
// ПОЧЕМУ У ЧАСТИ ТЕСТОВ ОГРАНИЧЕНИЯ ОСЛАБЛЕНЫ. Ограничения перекрывают друг друга, и отказ, который
// приходит первым, прячет тот, что проверяется. Замер этого перекрытия сам по себе полезен и
// записан в тестах: класс «нетто убывает по размеру всюду» почти целиком отсекается ПОТОЛКОМ
// РАЗБАВЛЕНИЯ раньше, чем доходит до своего кода, потому что у такого рынка база мала по
// определению. Отдельный код нужен остатку, который О2 пропускает.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpreadCsv } from "../src/engine/format.js";
import { scanTwoLeg } from "../src/engine/math.js";
import { DEFAULT_COSTS, roundTripCost } from "../src/engine/costs.js";
import { baseUsd } from "../src/engine/fa/dilution.js";
import {
  FA_SIZING_BINDINGS, FA_SIZING_DEFAULTS, FA_SIZING_PRESETS, FA_SIZING_REFUSALS,
  allocateCapital, bestSizeForMarket, concaveHull, costAtSize, explainSize, faSizingPreset,
  bookFillBps, bookSlippageNodes, flowWeightedBase, hasFunding, interpBps, logGrid, netAtSize,
  roomCeiling, sizeCeiling,
  sizeUniverse, uniformSizeFor, horizonScale, windowHours, windowValid,
} from "../src/engine/fa/sizing.js";
import { hour, row } from "./fa-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) < tol, `${label}: получено ${a}, ожидалось ${b} (+/-${tol})`);

// Круг двуногой в долях ноционала: (0.06 + 0.06 + 0.1)% GMX плюс 0.045% x 2 тейкера HL = 0.31%.
const K2 = (DEFAULT_COSTS.gmxOpen + DEFAULT_COSTS.gmxClose + DEFAULT_COSTS.gmxImpact
  + DEFAULT_COSTS.hlTaker * DEFAULT_COSTS.hlSides) / 100;
const GAS = DEFAULT_COSTS.gmxGas;
const netOracle = (P, B, S) => (P * S) / (B + S) - K2 * S - GAS;
const starOracle = (P, B) => Math.sqrt((P * B) / K2) - B;

// Рынок с постоянным потоком. `P` это ВЕСЬ поток окна в долларах, то есть та величина, которой
// оперирует оракул; ставка получается делением на базу, и тождество держится по построению.
const flatMarket = ({ hours = 720, P, bShort, bLong = 1e12 }) => {
  const pot = P / (3600 * hours);
  return Array.from({ length: hours }, (_, h) => hour(h, { pot, bShort, bLong }));
};

// Рынок из двух режимов: «тихие» часы и часы, в которые приходят деньги. Существует ровно для того,
// чтобы взвешенная потоком база отличалась от медианной, как она отличается на живых рынках.
const twoModeMarket = ({ quietHours, quietBase, quietPot, moneyHours, moneyBase, moneyPot, bLong = 1e12 }) => {
  const out = [];
  for (let h = 0; h < quietHours; h += 1) out.push(hour(h, { pot: quietPot, bShort: quietBase, bLong }));
  for (let h = 0; h < moneyHours; h += 1) out.push(hour(quietHours + h, { pot: moneyPot, bShort: moneyBase, bLong }));
  return out;
};

const liveOf = (rows, extra = {}) => {
  const last = rows[rows.length - 1];
  return { bOwnUsd: last.fbase_short, bOtherUsd: last.fbase_long, ...extra };
};

// Конфигурация A держит КОРОТКУЮ ногу GMX, поэтому наша база это `fbase_short`. Нога Hyperliquid во
// всех синтетических рынках нулевая: она не разбавляется и линейна по размеру, то есть только
// сдвинула бы оракул, ничего не проверив.
const marketOf = (rows, extra = {}, impact = null) => ({
  token: "T", config: "A", strategy: "two", rows, live: liveOf(rows, extra), impact,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Примитивы
// ─────────────────────────────────────────────────────────────────────────────

test("О2: потолок разбавления это B*d/(1-d), при d = 0.5 ровно база", () => {
  assert.equal(sizeCeiling(1e6, 0.5), 1e6, "d = 0.5 значит S <= B");
  assert.equal(sizeCeiling(1e6, 0.2), 0.25e6, "d = 0.2 значит S <= B/4");
  assert.equal(sizeCeiling(1e6, 1), Infinity, "d = 1 это отсутствие потолка");
  for (const b of [0, -1, NaN, undefined]) assert.equal(sizeCeiling(b, 0.5), 0, `база ${String(b)} не даёт места`);
  assert.equal(sizeCeiling(1e6, 0), 0, "нулевое разрешённое разбавление значит нулевой размер");
});

test("О1: место называет СВЯЗЫВАЮЩЕЕ ограничение по имени, а не только число", () => {
  // Без имени оператор не отличит «рынок мал» от «стакан тонок», а это разные решения.
  assert.deepEqual(roomCeiling({ gmxAvailOwnUsd: 1000, hlVisibleNtl: 5000 }), { usd: 1000, binding: "gmx" });
  assert.deepEqual(roomCeiling({ gmxAvailOwnUsd: 9000, hlVisibleNtl: 5000 }), { usd: 5000, binding: "book" });
  assert.deepEqual(roomCeiling({ gmxAvailOwnUsd: 9000, hlVisibleNtl: 5000, hlExhaustedFrom: 700 }), { usd: 700, binding: "exhausted" });
  assert.deepEqual(roomCeiling({}), { usd: Infinity, binding: null }, "ничего не известно значит ничего не связывает");
});

test("круг издержек НЕ константа: $2.55 при $500, $7.20 при $2000, $32.00 при $10000", () => {
  // Прежняя формулировка правила отбора («круг $7.20») брала круг ровно при $2000 и объявляла его
  // универсальным. Сравнивать максимум нетто с одним долларовым порогом нельзя.
  near(costAtSize({ sizeUsd: 500 }), 2.55, 1e-9, "круг при $500");
  near(costAtSize({ sizeUsd: 2000 }), 7.2, 1e-9, "круг при $2000");
  near(costAtSize({ sizeUsd: 10000 }), 32.0, 1e-9, "круг при $10000");
  near(costAtSize({ sizeUsd: 10000, isOneLeg: true }), 23.0, 1e-9, "однуногая без тейкера HL");
});

test("измеренная кривая удара ЗАМЕЩАЕТ плоские 0.1% движка, а не добавляется к ним", () => {
  // Плоские 0.1% это консервативная заглушка costs.js. Оставить её вместе с измеренной кривой
  // значило бы посчитать удар дважды, то есть выдумать издержки.
  const impact = { gmxNodes: [{ sizeUsd: 1000, bps: 0 }, { sizeUsd: 100000, bps: 0 }], hlNodes: [] };
  const flat = costAtSize({ sizeUsd: 10000 });
  const measured = costAtSize({ sizeUsd: 10000, impact });
  near(flat - measured, 10000 * 0.001, 1e-9, "разница ровно плоские 0.1% ноционала");
});

test("интерполяция ударов линейна по log10 размера и за краем держит крайний узел", () => {
  const nodes = [{ sizeUsd: 1000, bps: 1 }, { sizeUsd: 100000, bps: 5 }];
  near(interpBps(nodes, 1000), 1, 1e-12, "нижний узел");
  near(interpBps(nodes, 100000), 5, 1e-12, "верхний узел");
  near(interpBps(nodes, 10000), 3, 1e-12, "середина в логарифме");
  near(interpBps(nodes, 1), 1, 1e-12, "ниже измеренного держим нижний узел");
  near(interpBps(nodes, 1e9), 5, 1e-12, "выше измеренного держим верхний узел, а не достраиваем степень");
});

test("сетка включает ВЕРХНИЙ КРАЙ отдельным узлом", () => {
  // У рынков вроде BERA оптимум упирается в потолок ёмкости. Без узла ровно на потолке правило
  // вернуло бы размер ниже доступного просто потому, что сетка туда не попала.
  const g = logGrid(10, 25528, 0.1);
  assert.equal(g[0], 10);
  assert.equal(g[g.length - 1], 25528, "последний узел это сам потолок");
  for (let i = 1; i < g.length; i += 1) assert.ok(g[i] > g[i - 1], "сетка обязана строго возрастать");
});

test("вогнутая оболочка: отдача на доллар строго убывает, выпуклые участки сняты", () => {
  // net(S) НЕ вогнута: выпуклые участки есть у 59 рынков из 63. Жадность по сырым узлам на таком
  // участке выбирает шаг с меньшей отдачей и застревает.
  const pts = [{ sizeUsd: 500, net: 1 }, { sizeUsd: 1000, net: 1.5 }, { sizeUsd: 2000, net: 6 }, { sizeUsd: 4000, net: 7 }];
  const hull = concaveHull(pts, 500);
  assert.equal(hull[0].sizeUsd, 0, "оболочка начинается из нуля");
  assert.ok(!hull.some((p) => p.sizeUsd === 1000), "точка под хордой на оболочке лежать не имеет права");
  let prev = Infinity;
  for (let i = 1; i < hull.length; i += 1) {
    const slope = (hull[i].net - hull[i - 1].net) / (hull[i].sizeUsd - hull[i - 1].sizeUsd);
    assert.ok(slope < prev, `отдача на доллар обязана убывать: шаг ${i} дал ${slope}, предыдущий ${prev}`);
    prev = slope;
  }
  assert.equal(concaveHull(pts, 1500).some((p) => p.sizeUsd === 500), false, "точки ниже билета в оболочку не входят");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Нетто и оптимум против замкнутого оракула
// ─────────────────────────────────────────────────────────────────────────────

test("нетто при размере совпадает с замкнутым оракулом до цента", () => {
  const P = 16438;
  const B = 1e6;
  const rows = flatMarket({ P, bShort: B });
  for (const S of [500, 5000, 50000]) {
    const r = netAtSize({ rows, config: "A", sizeUsd: S });
    near(r.net, netOracle(P, B, S), 1e-6, `нетто при $${S}`);
    near(r.cost, K2 * S + GAS, 1e-9, `круг при $${S}`);
  }
});

test("оптимум по сетке с уточнением сходится к аналитическому S*", () => {
  // Разбавление даёт вогнутый доход, издержки линейны, поэтому максимум единственный и известен.
  const P = 16438;
  const B = 1e6;
  const rows = flatMarket({ P, bShort: B });
  const d = bestSizeForMarket({
    ...marketOf(rows),
    cfg: { ...FA_SIZING_DEFAULTS, ticketCapUsd: Infinity, allowExtrapolation: true, maxDilutionFraction: 0.999999 },
  });
  const want = starOracle(P, B);
  assert.ok(Math.abs(d.starUsd / want - 1) < 0.01, `S* = ${d.starUsd}, оракул ${want}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Ограничения, каждое своим тестом
// ─────────────────────────────────────────────────────────────────────────────

test("О1: размер не превышает свободного места, и связывающим назван стакан", () => {
  const rows = flatMarket({ P: 16438, bShort: 1e6 });
  const d = bestSizeForMarket({
    ...marketOf(rows, { gmxAvailOwnUsd: 5e5, hlVisibleNtl: 12345 }),
    cfg: { ...FA_SIZING_DEFAULTS, ticketCapUsd: Infinity },
  });
  assert.equal(d.refusal, null);
  assert.ok(d.sizeUsd <= 12345 + 1e-9, `размер ${d.sizeUsd} превысил видимый стакан`);
  assert.equal(d.binding, "book");
});

test("О1: места меньше минимального билета значит рынок не финансируется", () => {
  const rows = flatMarket({ P: 16438, bShort: 1e6 });
  const d = bestSizeForMarket({ ...marketOf(rows, { hlVisibleNtl: 100 }) });
  assert.equal(d.refusal, "no_room");
  assert.equal(d.sizeUsd, null, "при отказе размера не возвращается вовсе");
});

test("О2 берёт базу, ВЗВЕШЕННУЮ ПОТОКОМ, и поправка идёт в РАЗНЫЕ стороны на разных рынках", () => {
  // Это и есть причина, по которой квантиль не годится. Замер на живых данных: отношение
  // взвешенной базы к медиане равно 0.04 у BERA и 1.99 у SOL. Фиксированный p25 давил бы мажоров
  // без нужды и всё равно не спасал бы на тесных именах, то есть ошибался бы в обе стороны.
  const tail = twoModeMarket({ quietHours: 700, quietBase: 8000, quietPot: 1e-9, moneyHours: 20, moneyBase: 300, moneyPot: 1e-6 });
  const wide = twoModeMarket({ quietHours: 700, quietBase: 1e7, quietPot: 1e-4, moneyHours: 20, moneyBase: 3e7, moneyPot: 1e-2 });
  // Оракул считается прямо по определению sum(f*B)/sum(f) и медиане по часам.
  const byDefinition = (rows) => {
    let w = 0;
    let f = 0;
    const bs = [];
    for (const r of rows) { w += r.f_short * r.fbase_short; f += r.f_short; bs.push(r.fbase_short); }
    bs.sort((a, b) => a - b);
    return { weighted: w / f, median: bs[Math.floor(bs.length / 2)] };
  };
  for (const [label, rows, lo, hi] of [["хвостовой", tail, 0.02, 0.06], ["мажор", wide, 1.7, 2.3]]) {
    const o = byDefinition(rows);
    const got = flowWeightedBase(rows, "short");
    near(got.usd, o.weighted, Math.abs(o.weighted) * 1e-9 + 1e-9, `${label}: взвешенная база`);
    const ratio = got.usd / o.median;
    assert.ok(ratio > lo && ratio < hi, `${label}: отношение к медиане ${ratio}, ожидалось в (${lo}, ${hi})`);
  }
  // И главное следствие: потолок О2 у хвостового рынка в десятки раз строже, чем дала бы медиана.
  const t = byDefinition(tail);
  const strict = sizeCeiling(flowWeightedBase(tail, "short").usd, 0.5);
  const naive = sizeCeiling(t.median, 0.5);
  assert.ok(naive / strict > 20, `медианная база разрешила бы вход в ${naive / strict} раз больший`);
});

test("О2: потолок разбавления связывает размер и назван связывающим", () => {
  const B = 20000;
  const rows = flatMarket({ P: 16438, bShort: B });
  const d = bestSizeForMarket({ ...marketOf(rows), cfg: { ...FA_SIZING_DEFAULTS, ticketCapUsd: Infinity } });
  assert.equal(d.refusal, null);
  near(d.sizeUsd, B, 1e-6, "при d = 0.5 размер упирается ровно в базу");
  assert.equal(d.binding, "dilution");
});

test("О3: за последний ИЗМЕРЕННЫЙ узел стакана правило не ходит", () => {
  // Рынок построен так, что его аналитический оптимум ($1.30 млн) лежит ВЫШЕ последнего измеренного
  // узла: иначе запрет нечему связывать и тест прошёл бы, ничего не проверив.
  const rows = flatMarket({ P: 16438, bShort: 1e6 });
  const cfg = { ...FA_SIZING_DEFAULTS, ticketCapUsd: Infinity };
  assert.ok(starOracle(16438, 1e6) > FA_SIZING_DEFAULTS.hlLastMeasuredNodeUsd, "оракул обязан звать выше узла");
  const blocked = bestSizeForMarket({ ...marketOf(rows), cfg });
  assert.equal(blocked.refusal, null, "рынок обязан финансироваться, иначе запрет проверять не на чем");
  assert.ok(blocked.sizeUsd <= FA_SIZING_DEFAULTS.hlLastMeasuredNodeUsd + 1e-9, `размер ${blocked.sizeUsd} вышел за измеренный узел`);
  assert.equal(blocked.binding, "extrapolation_blocked");
  const open = bestSizeForMarket({ ...marketOf(rows), cfg: { ...cfg, allowExtrapolation: true } });
  assert.equal(open.refusal, null);
  assert.ok(open.sizeUsd > FA_SIZING_DEFAULTS.hlLastMeasuredNodeUsd, "с разрешённой экстраполяцией размер обязан вырасти");
});

test("О4: без конечного потолка капитала функция возвращает ОТКАЗ, а не число", () => {
  // Безлимитная честная оптимизация занимает $5.02 млн и приносит минус $232 553 в год. Потолок
  // капитала работает не как ограничение, а как единственный работающий регуляризатор.
  const rows = flatMarket({ P: 16438, bShort: 1e6 });
  for (const cap of [Infinity, NaN, 0, -1, undefined]) {
    const u = sizeUniverse({ markets: [marketOf(rows)], capitalTotal: cap });
    assert.equal(u.refusals[0].refusal, "no_capital_cap", `капитал ${String(cap)}`);
    assert.equal(u.alloc.size, 0, "ни одного размера выдано быть не должно");
  }
});

test("О4: сумма выданного не превышает капитала, а итог не убывает при его росте", () => {
  const a = marketOf(flatMarket({ P: 16438, bShort: 1e6 }));
  const b = { ...marketOf(flatMarket({ P: 12000, bShort: 1e6 })), token: "U" };
  let prevNet = -Infinity;
  for (const cap of [3000, 6000, 12000, 40000]) {
    const u = sizeUniverse({ markets: [a, b], capitalTotal: cap });
    const sum = [...u.alloc.values()].reduce((s, x) => s + x, 0);
    assert.ok(sum <= cap + 1e-9, `выдано $${sum} при капитале $${cap}`);
    assert.ok(u.netTotal >= prevNet - 1e-9, `итог упал при росте капитала: $${u.netTotal} после $${prevNet}`);
    prevNet = u.netTotal;
    for (const v of u.alloc.values()) assert.ok(v >= FA_SIZING_DEFAULTS.minTicketUsd, `выдан размер $${v} ниже билета`);
  }
});

test("О5: оптимум ниже минимального билета это отказ, а не округление вверх", () => {
  // База $600, оптимум около $470: рынок в плюсе, но войти в него мы умеем только билетом $500,
  // и вход билетом уже хуже оптимума. Округлить вверх значило бы торговать не тот размер.
  const B = 600;
  const P = K2 * (B + 470) ** 2 / B;
  const rows = flatMarket({ P, bShort: B });
  const d = bestSizeForMarket({ ...marketOf(rows) });
  assert.equal(d.refusal, "below_min_ticket");
  assert.ok(d.starUsd < FA_SIZING_DEFAULTS.minTicketUsd, `оптимум ${d.starUsd} обязан лежать ниже билета`);
  assert.ok(netOracle(P, B, 500) < netOracle(P, B, d.starUsd), "вход билетом обязан быть хуже оптимума");
});

test("О6: строгий режим не даёт стать БОЛЬШЕЙ стороной, и по умолчанию он выключен", () => {
  const rows = flatMarket({ P: 16438, bShort: 1e6, bLong: 1.2e6 });
  const cfg = { ...FA_SIZING_DEFAULTS, ticketCapUsd: Infinity };
  const loose = bestSizeForMarket({ ...marketOf(rows), cfg });
  assert.notEqual(loose.binding, "flip", "по умолчанию переворот не ограничивает");
  const strict = bestSizeForMarket({ ...marketOf(rows), cfg: { ...cfg, flipGuard: true } });
  near(strict.sizeUsd, 1.2e6 - 1e6, 1e-6, "потолок это разница баз сторон");
  assert.equal(strict.binding, "flip");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Потолок тикета и сжатие
// ─────────────────────────────────────────────────────────────────────────────

test("потолок тикета: S = min(S*, T), и оптимум до потолка остаётся в решении", () => {
  // T это ДОПУЩЕНИЕ, подобранное на тех же данных, где мерилось. Поэтому оптимум до потолка обязан
  // остаться виден: без него нельзя будет уточнить T, не переписывая конструкцию.
  const rows = flatMarket({ P: 16438, bShort: 1e6 });
  const d = bestSizeForMarket({ ...marketOf(rows) });
  assert.equal(d.sizeUsd, FA_SIZING_DEFAULTS.ticketCapUsd);
  assert.equal(d.binding, "ticket_cap");
  assert.ok(d.starUsd > d.sizeUsd, `оптимум ${d.starUsd} обязан быть выше потолка`);
  near(d.netUsd, netOracle(16438, 1e6, 5000), 1e-6, "нетто считается при ТОРГУЕМОМ размере");
  const open = bestSizeForMarket({ ...marketOf(rows), cfg: { ...FA_SIZING_DEFAULTS, ticketCapUsd: Infinity } });
  assert.ok(open.sizeUsd > FA_SIZING_DEFAULTS.ticketCapUsd, "без потолка размер обязан вырасти");
});

test("сжатие к единому размеру: при w = 0 множителя нет ПОБИТОВО, при w = 1 остаётся единый размер", () => {
  const rows = flatMarket({ P: 16438, bShort: 1e6 });
  const cfg = { ...FA_SIZING_DEFAULTS, ticketCapUsd: Infinity };
  const off = bestSizeForMarket({ ...marketOf(rows), cfg, uniformSizeUsd: 3162 });
  const noUni = bestSizeForMarket({ ...marketOf(rows), cfg, uniformSizeUsd: null });
  assert.equal(off.sizeUsd, noUni.sizeUsd, "выключенное сжатие обязано не менять НИ ОДНОГО разряда");
  const half = bestSizeForMarket({ ...marketOf(rows), cfg: { ...cfg, shrinkToUniform: 0.5 }, uniformSizeUsd: 3162 });
  near(half.sizeUsd, Math.sqrt(off.starUsd * 3162), 1e-6, "w = 0.5 это геометрическое среднее");
  const full = bestSizeForMarket({ ...marketOf(rows), cfg: { ...cfg, shrinkToUniform: 1 }, uniformSizeUsd: 3162 });
  near(full.sizeUsd, 3162, 1e-6, "w = 1 это единый размер целиком");
});

test("единый размер НЕ считает рынки, которым отказано: смещение снято явно", () => {
  // В прогонах сравнения конструкций отбор эти рынки отсекал, а в выбор ЕДИНОГО размера они входили
  // своими ОТРИЦАТЕЛЬНЫМИ вкладами, потому что единый размер это argmax суммы по ВСЕМ рынкам.
  // На отбор они не влияли, а на выбор размера влияли, и фильтр этого сам не чинит.
  const good = { token: "G", refusal: null, points: [{ sizeUsd: 1000, net: 10 }, { sizeUsd: 5000, net: 40 }] };
  const dead = { token: "D", refusal: "no_funding", points: [{ sizeUsd: 1000, net: -1 }, { sizeUsd: 5000, net: -900 }] };
  assert.equal(uniformSizeFor([good]), 5000);
  assert.equal(uniformSizeFor([good, dead]), 5000, "отказавший рынок не имеет права двигать единый размер");
  // Контроль: если бы он считался, argmax съехал бы на меньший размер.
  const asIfCounted = uniformSizeFor([good, { ...dead, refusal: null }]);
  assert.equal(asIfCounted, 1000, "контроль: посчитанный отказавший рынок действительно двигает выбор");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Отбор рынка по окупаемости круга
// ─────────────────────────────────────────────────────────────────────────────

test("отбор: нетто обязано окупать круг ПРИ СВОЁМ размере с запасом k", () => {
  // Порог назначается безразмерному отношению, потому что стоимость решения не константа.
  // Условие «нетто больше круга» тождественно условию «брутто больше двух кругов».
  const P = 5000;
  const B = 1e6;
  const rows = flatMarket({ P, bShort: B });
  const at = netOracle(P, B, 5000);
  const cost = K2 * 5000 + GAS;
  assert.ok(at > 0 && at < cost, "рынок построен в плюс, но круг не окупающим");
  const strict = bestSizeForMarket({ ...marketOf(rows) });
  assert.equal(strict.refusal, "below_fund_ratio");
  near(strict.ratio, at / cost, 1e-9, "отношение печатается и при отказе");
  const loose = bestSizeForMarket({ ...marketOf(rows), cfg: { ...FA_SIZING_DEFAULTS, fundRatioK: 0 } });
  assert.equal(loose.refusal, null, "при k = 0 достаточно просто плюса");
});

test("отношение считается ПРИ ТОРГУЕМОМ размере, а отношение при оптимуме идёт в журнал", () => {
  // Мерить экономику решения на размере, которым мы не войдём, есть ровно тот дефект, из-за
  // которого ANIME и MEME проходили отбор числом с края сетки.
  const rows = flatMarket({ P: 16438, bShort: 1e6 });
  const d = bestSizeForMarket({ ...marketOf(rows) });
  near(d.ratio, d.netUsd / d.costUsd, 1e-12, "отношение это нетто на круг при торгуемом размере");
  assert.ok(Number.isFinite(d.ratioAtStar), "отношение при оптимуме обязано быть посчитано");
  assert.notEqual(d.ratio, d.ratioAtStar, "при связавшем потолке тикета эти числа разные");
});

test("класс «нетто убывает по размеру всюду» получает СВОЙ код и не проходит отбор", () => {
  // Настоящий максимум лежит НИЖЕ края сетки, а край уже ниже минимального билета. Реальные
  // представители: ANIME (край $3.31, отношение 2.53, на билете $500 нетто минус $2.66) и MEME
  // (край $1.40, отношение 1.07, на билете минус $1.03). Без своего кода такой рынок попадёт в
  // финансируемые по числу, которого в бою не существует.
  //
  // ЗАМЕР ПЕРЕКРЫТИЯ ОГРАНИЧЕНИЙ, полезный сам по себе: у такого рынка база мала по определению,
  // поэтому потолок разбавления О2 отсекает почти весь класс раньше своим кодом `no_room`. Здесь
  // О2 ослаблен нарочно, чтобы дойти до остатка, который он пропускает.
  const B = 5;
  const P = 4;
  const rows = flatMarket({ P, bShort: B });
  const cfg = { ...FA_SIZING_DEFAULTS, gridMinUsd: 100, maxDilutionFraction: 0.999, ticketCapUsd: Infinity };
  const edgeNet = netOracle(P, B, 100);
  const edgeCost = K2 * 100 + GAS;
  assert.ok(edgeNet / edgeCost > cfg.fundRatioK, "рынок построен так, что по числу с края он отбор ПРОХОДИТ");
  const d = bestSizeForMarket({ ...marketOf(rows), cfg });
  assert.equal(d.refusal, "decreasing_at_every_size");
  assert.equal(d.sizeUsd, null, "размер не выдаётся");
  // И контроль на перекрытие: с боевым О2 тот же рынок отсекается раньше и другим кодом.
  const withO2 = bestSizeForMarket({ ...marketOf(rows), cfg: { ...cfg, maxDilutionFraction: 0.5 } });
  assert.equal(withO2.refusal, "no_room");
});

test("нетто отрицательно на всей сетке это НОРМАЛЬНЫЙ исход, а не ошибка", () => {
  const rows = flatMarket({ P: 500, bShort: 1e6 });
  const d = bestSizeForMarket({ ...marketOf(rows) });
  assert.equal(d.refusal, "negative_at_every_size");
});

test("распределитель детерминирован: при равных отдачах порядок задаёт имя рынка", () => {
  // Замер: разброс итога по 20 законным порядкам отбора составил $19.9 тыс при измеряемом разрыве
  // конструкций $2.4 тыс, то есть недетерминированный порядок сам по себе больше того, что мерят.
  const curve = (token) => ({ token, refusal: null, hull: [{ sizeUsd: 0, net: 0 }, { sizeUsd: 1000, net: 10 }] });
  const a = allocateCapital([curve("B"), curve("A")], 1000);
  const b = allocateCapital([curve("A"), curve("B")], 1000);
  assert.deepEqual([...a.alloc], [...b.alloc], "порядок аргументов не имеет права менять ответ");
  assert.deepEqual([...a.alloc.keys()], ["A"], "при равных отдачах первым берётся рынок с меньшим именем");
  assert.equal(allocateCapital([curve("A")], Infinity).refusal, "no_capital_cap");
});

test("ставки НЕТ и ставка РОВНО НОЛЬ это разные сообщения", () => {
  // Пропавшее снабжение, названное «фандинга на рынке нет», молча увело бы рынок из среза навсегда:
  // отсутствие предмета это нормальный исход, а отказ источника требует починки.
  const missing = Array.from({ length: 24 }, (_, h) => row(h, { fs: NaN, fl: NaN, fbS: 1e6, fbL: 1e6 }));
  assert.equal(bestSizeForMarket({ ...marketOf(missing, { bOwnUsd: 1e6 }) }).refusal, "no_base");
});

test("нулевая ставка это ОТСУТСТВИЕ ПРЕДМЕТА и свой код, а не плохие данные", () => {
  // Замер: у AAVE, ATOM, AVAX, NEAR и OP индексатор даёт 168 снимков из 168 с ровно нулевой ставкой
  // в окне внутри второго периода, а у BTC и LINK 168 из 168 ненулевых там же, и собранный раньше
  // сторонний кэш согласен с индексатором. Фандинга на этих рынках тогда не было.
  //
  // Правило по ПРИЗНАКУ, а не по списку имён: те же имена в году 2025-06..2026-06 фандинг платят,
  // и зашитый список запретил бы работающие рынки.
  const rows = Array.from({ length: 720 }, (_, h) => row(h, { fs: 0, fl: 0, fbS: 1e6, fbL: 1e6 }));
  assert.equal(hasFunding(rows, "short"), false);
  const d = bestSizeForMarket({ ...marketOf(rows) });
  assert.equal(d.refusal, "no_funding");
  // Тот же рынок с ненулевой ставкой этот код уже не получает: признак различает предмет, а не имя.
  assert.equal(hasFunding(flatMarket({ P: 1, bShort: 1e6 }), "short"), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Проходка по стакану: живой источник кривой проскальзывания
// ─────────────────────────────────────────────────────────────────────────────

test("проходка по стакану даёт цену прохода, а нехватку глубины называет НЕЧИСЛОМ", () => {
  // Нехватка стакана это «неизвестно», а не «ноль» и не «дорого». Подставить сюда число значило бы
  // выдумать издержку ровно там, где её измерить нечем.
  const bids = [{ px: 100, sz: 10 }];
  const asks = [{ px: 102, sz: 10 }];
  near(bookFillBps(asks, 101, 1000), 99.0099, 1e-3, "проходка покупки на $1000");
  near(bookFillBps(bids, 101, 1000), 99.0099, 1e-3, "проходка продажи на $1000");
  assert.ok(Number.isNaN(bookFillBps(asks, 101, 5000)), "стакана не хватает: обязано быть нечисло");
  const r = bookSlippageNodes({ bids, asks, nodesUsd: [500, 1000, 5000] });
  assert.deepEqual(r.nodes.map((n) => n.sizeUsd), [500, 1000], "узлы считаются, пока хватает глубины");
  near(r.nodes[1].bps, 198.0198, 1e-3, "круг это проходка покупки плюс проходка продажи");
  assert.equal(r.visibleNtl, 1000, "видимый объём это меньшая из двух сторон");
  assert.equal(r.exhaustedFrom, 5000, "с какого размера стакан кончается, обязано быть названо");
});

test("АГРЕГИРОВАННЫЙ стакан даёт другую проходку, поэтому он запрещён", () => {
  // Замер: агрегация округляет цену верхнего уровня, и у ETH при nSigFigs = 3 проходка выходила
  // 20.28 базисного пункта против 0.20 на полной точности. Запрет обоснован числом, а не вкусом.
  const bids = [{ px: 99.99, sz: 100 }];
  const fine = [{ px: 100.0, sz: 100 }];
  const coarse = [{ px: 101.0, sz: 100 }]; // та же ликвидность, цена округлена до границы корзины
  const mid = (99.99 + 100.0) / 2;
  const a = bookFillBps(fine, mid, 1000);
  const b = bookFillBps(coarse, mid, 1000);
  near(a, 0.50003, 1e-3, "полная точность");
  assert.ok(b / a > 100, `агрегация обязана менять ответ на порядки: получено ${b / a} раза`);
  assert.equal(bookSlippageNodes({ bids: [], asks: fine, nodesUsd: [1000] }).nodes.length, 0, "без встречной стороны середины нет");
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Лестница отказов и полнота реестров
// ─────────────────────────────────────────────────────────────────────────────

test("каждый код отказа ДОСТИЖИМ, и ни одна ветка не возвращает кода вне реестра", () => {
  // Проверка, которая перечисляет коды, но не умеет их получить, охраняет только собственный список.
  const rows = flatMarket({ P: 16438, bShort: 1e6 });
  const seen = new Set();
  const take = (d) => { if (d && d.refusal) seen.add(d.refusal); };

  take(bestSizeForMarket({ ...marketOf(rows), cfg: { ...FA_SIZING_DEFAULTS, horizonH: NaN } }));
  take(bestSizeForMarket({ ...marketOf(rows), cfg: { ...FA_SIZING_DEFAULTS, windowH: NaN } }));
  take(bestSizeForMarket({ ...marketOf(rows, { bOwnUsd: 0 }) }));
  take(bestSizeForMarket({ ...marketOf(rows, { baseAgeSec: 999 }) }));
  take(bestSizeForMarket({ ...marketOf(rows, { baseIdentityOk: false }) }));
  take(bestSizeForMarket({ ...marketOf(rows, { bookMissing: true }) }));
  take(bestSizeForMarket({ ...marketOf(rows, { bookAgeSec: 999 }) }));
  take(bestSizeForMarket({ ...marketOf(rows, { hlVisibleNtl: 100 }) }));
  take(bestSizeForMarket({ ...marketOf(Array.from({ length: 24 }, (_, h) => row(h, { fs: 0, fl: 0, fbS: 1e6, fbL: 1e6 }))) }));
  take(bestSizeForMarket({ ...marketOf(flatMarket({ P: 500, bShort: 1e6 })) }));
  take(bestSizeForMarket({ ...marketOf(flatMarket({ P: 5000, bShort: 1e6 })) }));
  take(bestSizeForMarket({ ...marketOf(flatMarket({ P: K2 * 1070 ** 2 / 600, bShort: 600 })) }));
  take(bestSizeForMarket({
    ...marketOf(flatMarket({ P: 4, bShort: 5 })),
    cfg: { ...FA_SIZING_DEFAULTS, gridMinUsd: 100, maxDilutionFraction: 0.999, ticketCapUsd: Infinity },
  }));
  for (const r of sizeUniverse({ markets: [marketOf(rows)], capitalTotal: Infinity }).refusals) seen.add(r.refusal);
  for (const r of sizeUniverse({ markets: [marketOf(rows)], capitalTotal: 1e4, cfg: { ...FA_SIZING_DEFAULTS, horizonH: 0 } }).refusals) seen.add(r.refusal);
  for (const r of sizeUniverse({ markets: [marketOf(rows)], capitalTotal: 1e4, cfg: { ...FA_SIZING_DEFAULTS, windowH: 0 } }).refusals) seen.add(r.refusal);
  for (const r of sizeUniverse({ markets: [marketOf(rows)], capitalTotal: 1e4, sources: { gmxDown: true } }).refusals) seen.add(r.refusal);
  for (const r of sizeUniverse({ markets: [marketOf(rows)], capitalTotal: 1e4, sources: { hlDown: true } }).refusals) seen.add(r.refusal);
  // Капитала хватает ровно на один рынок из двух: второй обязан назвать причину, а не исчезнуть.
  const two = sizeUniverse({
    markets: [marketOf(rows), { ...marketOf(flatMarket({ P: 12000, bShort: 1e6 })), token: "U" }],
    capitalTotal: 5000,
  });
  for (const r of two.refusals) seen.add(r.refusal);

  const registry = new Set(FA_SIZING_REFUSALS);
  for (const code of seen) assert.ok(registry.has(code), `код «${code}» возвращён, но в реестре его нет`);
  const missing = FA_SIZING_REFUSALS.filter((c) => !seen.has(c));
  assert.deepEqual(missing, [], `коды реестра, которых никто не получил: ${missing.join(", ")}`);
});

test("каждое имя связывающего ограничения достижимо", () => {
  const rows = flatMarket({ P: 16438, bShort: 1e6, bLong: 1.2e6 });
  const cfg = { ...FA_SIZING_DEFAULTS, ticketCapUsd: Infinity };
  const seen = new Set();
  seen.add(bestSizeForMarket({ ...marketOf(rows, { gmxAvailOwnUsd: 4000 }), cfg }).binding);
  seen.add(bestSizeForMarket({ ...marketOf(rows, { hlVisibleNtl: 4000 }), cfg }).binding);
  seen.add(bestSizeForMarket({ ...marketOf(rows, { hlExhaustedFrom: 4000 }), cfg }).binding);
  seen.add(bestSizeForMarket({ ...marketOf(flatMarket({ P: 16438, bShort: 20000 })), cfg }).binding);
  seen.add(bestSizeForMarket({ ...marketOf(rows), cfg }).binding);
  seen.add(bestSizeForMarket({ ...marketOf(rows), cfg: { ...cfg, flipGuard: true } }).binding);
  seen.add(bestSizeForMarket({ ...marketOf(rows) }).binding);
  seen.add(bestSizeForMarket({ ...marketOf(flatMarket({ P: 1e6, bShort: 1e9 })), cfg: { ...cfg, allowExtrapolation: true } }).binding);
  seen.add(bestSizeForMarket({ ...marketOf(flatMarket({ P: 16438, bShort: 1e6 })), cfg: { ...cfg, maxDilutionFraction: 0.99, allowExtrapolation: true } }).binding);
  for (const b of seen) assert.ok(FA_SIZING_BINDINGS.includes(b), `связывающее «${b}» вне реестра`);
  for (const b of ["gmx", "book", "exhausted", "dilution", "extrapolation_blocked", "flip", "ticket_cap"]) {
    assert.ok(seen.has(b), `связывающее «${b}» не получено ни разу`);
  }
});

test("журнал решения называет и размер, и связывающее, и отказ", () => {
  const rows = flatMarket({ P: 16438, bShort: 1e6 });
  const ok = explainSize(bestSizeForMarket({ ...marketOf(rows) }));
  assert.match(ok, /\$5000/);
  assert.match(ok, /потолок тикета/);
  const bad = explainSize(bestSizeForMarket({ ...marketOf(rows, { bOwnUsd: 0 }) }));
  assert.match(bad, /no_base/);
  assert.match(bad, /не финансируем/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Пресеты и изоляция от бота 2
// ─────────────────────────────────────────────────────────────────────────────

test("пресет это ЧИСТЫЕ ДАННЫЕ: вооружение им и теми же полями россыпью совпадает побитово", () => {
  const rows = flatMarket({ P: 16438, bShort: 1e6, bLong: 1.2e6 });
  const strip = (d) => JSON.stringify({ ...d, points: d.points.length, hull: d.hull.length });
  for (const id of Object.keys(FA_SIZING_PRESETS)) {
    const byId = bestSizeForMarket({ ...marketOf(rows), cfg: faSizingPreset(id), uniformSizeUsd: 3162 });
    const byFields = bestSizeForMarket({ ...marketOf(rows), cfg: { ...FA_SIZING_PRESETS[id].cfg }, uniformSizeUsd: 3162 });
    assert.equal(strip(byId), strip(byFields), `пресет ${id} обязан быть данными, а не веткой исполнения`);
  }
  assert.equal(faSizingPreset("нет такого"), null);
  // Замеренность пресета обязана быть объявлена: боевой помечен НЕзамеренным, потому что потолок
  // тикета и вес сжатия подобраны на тех же данных, на которых мерились.
  assert.equal(FA_SIZING_PRESETS["fa-per-market-h720-v1"].calibrated, false);
  assert.equal(FA_SIZING_PRESETS["fa-uniform-v1"].calibrated, true);
});

test("замыкание импортов правила размера НЕ пересекается с ботом 2", () => {
  // Бот 2 доведён до состояния, которое тестируется нетронутым, и у него идёт живой прогон.
  // Общий модуль между ботами это способ уронить второго правкой первого.
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*import[^"']*["'](\.[^"']+)["']/gm)) walk(join(dirname(file), m[1]));
  };
  walk(join(HERE, "..", "src", "engine", "fa", "sizing.js"));
  const btc = [...seen].filter((f) => f.includes("btcopt"));
  assert.deepEqual(btc, [], `правило размера тянет модули бота 2: ${btc.join(", ")}`);
  assert.ok(seen.size >= 4, "замыкание обязано быть непустым, иначе тест проверяет опечатку в пути");
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Абсолютная величина на настоящих данных репозитория
// ─────────────────────────────────────────────────────────────────────────────

test("APT, BTC и ETH: размер и нетто на блоке 720 часов совпадают с замеренными числами", () => {
  // ЕДИНСТВЕННАЯ проверка правила, которая смотрит на АБСОЛЮТНУЮ величину. Ошибка, масштабирующая
  // обе базы разом (единицы, множитель 1e30, поле другой размерности), проходит тождество насквозь,
  // и поймать её можно только сравнением с известным числом. Опасно именно ЗАВЫШЕНИЕ базы:
  // множитель уходит к единице, разбавление исчезает, и правило бесшумно возвращается к фантому.
  //
  // Кривая прогона разбавления (+$190 при $1000, пик +$1787 при $24000, минус $27843 при $300000)
  // снята на кэше ставок 63 рынков, которого в репозитории нет; она сверяется скриптом
  // `scripts/funding-arb-study/vfy-size-1-curve.mjs`. Здесь тот же смысл на данных, которые в
  // репозитории есть.
  const DATA = join(HERE, "..", "..", "data", "funding-arb");
  const cap = JSON.parse(readFileSync(join(DATA, "snapshots", "cap63.json"), "utf8"));
  const H = FA_SIZING_DEFAULTS.horizonH;
  // Кривые ценового удара сюда НЕ передаются нарочно: тогда круг равен `roundTripCost` движка
  // ровно, и последняя проверка ниже связывает числа правила с уже ратифицированной моделью
  // издержек, а не с ещё одной таблицей.
  const want = {
    APT: { size: 5000, net: 135.066877, star: 31088.479516, ratio: 8.185871, keep: 0.97222 },
    BTC: { size: 5000, net: 32.718972, star: 500000, ratio: 1.982968, keep: 0.99986 },
    ETH: { size: 5000, net: 44.082393, star: 500000, ratio: 2.671660, keep: 0.99987 },
  };
  for (const token of ["APT", "BTC", "ETH"]) {
    const raw = parseSpreadCsv(readFileSync(join(HERE, "fixtures", `${token}.csv`), "utf8"));
    const oi = JSON.parse(gunzipSync(readFileSync(join(DATA, "gmx-oi-snapshots", `${token}.json.gz`))).toString("utf8")).oi;
    const bases = new Map(oi.map((r) => [Number(r.snapshotTimestamp), r]));
    const rows = raw.map((r) => {
      const o = bases.get(r.tsHour);
      return o ? { ...r, fbase_long: baseUsd(o.longFundingBalanceOiUsd), fbase_short: baseUsd(o.shortFundingBalanceOiUsd) } : r;
    });
    // Конфигурацию выбирает движок по ПРЕДШЕСТВУЮЩЕМУ блоку: правило так и работает, а выбор её
    // здесь заново был бы второй реализацией того же решения.
    const config = scanTwoLeg(rows.slice(0, H), { token }).chosen;
    const seg = rows.slice(H, 2 * H);
    const side = config === "A" ? "short" : "long";
    const room = cap.find((x) => x.t === token);
    const last = seg[seg.length - 1];
    const d = bestSizeForMarket({
      token, config, strategy: "two", rows: seg,
      live: {
        bOwnUsd: side === "short" ? last.fbase_short : last.fbase_long,
        bOtherUsd: side === "short" ? last.fbase_long : last.fbase_short,
        gmxAvailOwnUsd: side === "short" ? room.availShort : room.availLong,
      },
    });
    const w = want[token];
    assert.equal(d.refusal, null, `${token}: рынок обязан финансироваться`);
    near(d.sizeUsd, w.size, 1e-6, `${token}: размер`);
    near(d.starUsd, w.star, 5e-4, `${token}: оптимум до потолка тикета`);
    near(d.netUsd, w.net, 5e-4, `${token}: нетто`);
    near(d.ratio, w.ratio, 1e-4, `${token}: окупаемость круга`);
    near(d.dilutionRetained, w.keep, 1e-5, `${token}: доля удержания потока`);
    near(d.costUsd, roundTripCost(DEFAULT_COSTS, w.size, false), 1e-9, `${token}: круг при торгуемом размере`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ОКНО ОЦЕНКИ НАЗАД И ГОРИЗОНТ ВПЕРЁД (решение владельца 2026-09-02)
//
// Одно число в двух ролях разнесено на два: по окну режется кадр и считается поток, на горизонт
// амортизируется круг. Брутто окна умножается на `horizonH / windowH`. При равных значениях ничего
// не двигается ни на бит, и на этом стоят шесть книг охраны.
// ─────────────────────────────────────────────────────────────────────────────

test("окно и горизонт: при равных значениях число не двигается ни на бит, при разных брутто масштабируется, круг нет", () => {
  const rows = flatMarket({ P: 16438, bShort: 1e6 });
  const at = (cfg) => netAtSize({ rows, config: "A", strategy: "two", sizeUsd: 2000, cfg });
  const base = at({ ...FA_SIZING_DEFAULTS });
  assert.equal(FA_SIZING_DEFAULTS.windowH, FA_SIZING_DEFAULTS.horizonH, "по умолчанию равны: единственное замеренное сочетание");
  assert.equal(horizonScale(FA_SIZING_DEFAULTS), 1);
  assert.equal(at({ ...FA_SIZING_DEFAULTS, windowH: undefined }).gross, base.gross, "без окна: окно равно горизонту, множитель единица");
  assert.equal(at({ ...FA_SIZING_DEFAULTS, windowH: FA_SIZING_DEFAULTS.horizonH }).net, base.net, "явное равное окно: побитово то же");
  const dbl = at({ ...FA_SIZING_DEFAULTS, horizonH: 2 * FA_SIZING_DEFAULTS.windowH });
  assert.ok(Math.abs(dbl.gross - 2 * base.gross) < 1e-9, "вдвое длиннее горизонт вперёд: вдвое больше брутто окна");
  assert.equal(dbl.cost, base.cost, "круг не масштабируется: платится один раз");
  assert.ok(Math.abs(dbl.net - (2 * base.gross - base.cost)) < 1e-9);
  assert.ok(Math.abs(dbl.parts.gmxFundingUsd - 2 * base.parts.gmxFundingUsd) < 1e-9, "части ноги в тех же единицах, что и брутто");
  assert.equal(windowHours({ horizonH: 5 }), 5);
  assert.equal(windowHours({ horizonH: 5, windowH: 3 }), 3);
  assert.equal(windowValid({ windowH: 0 }), false);
  assert.equal(windowValid({ windowH: NaN }), false);
  assert.equal(windowValid({}), true);
  assert.equal(horizonScale({ horizonH: 0, windowH: 720 }), 1, "непригодный горизонт масштаба не даёт: отказ выше по стеку");
  // Правило по рынку с явным окном 720 даёт побитово то же, что по умолчанию.
  const a = bestSizeForMarket({ ...marketOf(rows) });
  const b = bestSizeForMarket({ ...marketOf(rows), cfg: { ...FA_SIZING_DEFAULTS, windowH: 720 } });
  assert.equal(a.netUsd, b.netUsd);
  assert.equal(a.sizeUsd, b.sizeUsd);
  // Пресеты несут оба числа: окно нельзя выводить из горизонта молча.
  for (const p of Object.values(FA_SIZING_PRESETS)) assert.equal(p.cfg.windowH, p.cfg.horizonH, `${p.id}: окно и горизонт пресета`);
});
