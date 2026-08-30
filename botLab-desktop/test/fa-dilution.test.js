// fa-dilution.test.js - РАЗБАВЛЕНИЕ ВХОДА СОБСТВЕННЫМ РАЗМЕРОМ: сама формула (fa/dilution.js) и
// три правила её применения в леджере (paper.js).
//
// ЧЕМ ЭТОТ ФАЙЛ ЗАКРЫВАЕТ ДЫРУ, КОТОРУЮ КНИГА НЕ ВИДИТ. Книга `base-fa-dil.tsv` снимается на трёх
// фикстурах, и базы там покрывают все 8761 час без единой дыры, а платит и получает каждая сторона
// в своих часах. То есть книга стережёт ИТОГ на одном наборе данных, но не умеет отличить причину
// от причины: подмена «плательщика определяет знак» на «плательщика определяет база» сдвинет её
// числа, и по одной сумме нельзя будет сказать, какое из правил уехало. Здесь каждое правило
// проверяется отдельно и на данных, построенных специально против него.
//
// ЧИСЛА В ПРОВЕРКАХ НЕ ВЫДУМАНЫ. Опорная пара взята из разбора прогона: у BTC `f_short` равна
// 2.4e-8 в секунду при базе `B_short` = $2.11e7, и при входе $1000 верный множитель равен
// 0.999953, а опровергнутый `S/(B+S)` равен 4.7e-5, то есть в 21 тысячу раз меньше.

import test from "node:test";
import assert from "node:assert/strict";
import {
  FA_IDENTITY_MAX_REL_ERR, NO_DILUTION, baseUsd, dilutedFundingRate, dilutionFactor, potOf, resolveBase,
} from "../src/engine/fa/dilution.js";
import { openPosition, accrue, accrueFromRows, closePosition, positionSummary, accountSummary } from "../src/engine/paper.js";
import { buildLedger, ledgerReconciles } from "../src/engine/ledger.js";
import { buildSnapshot } from "../src/engine/assemble.js";

const HOUR = 3600 * 1000;
const BASE_MS = 1699999200000; // метка, выровненная по границе часа
const BASE_S = BASE_MS / 1000;
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) < tol, `${label}: получено ${a}, ожидалось ${b} (+/-${tol})`);
// Опровергнутая форма S/(B+S). Живёт ТОЛЬКО в тесте: её задача быть тем, от чего верная форма
// обязана отличаться, и в боевом коде её присутствие было бы приглашением перепутать снова.
const refuted = (b, s) => s / (b + s);

// Часовая строка канонического кадра. Знак f по конвенции Subsquid: f_short > 0 значит получает
// короткая сторона.
const row = (h, { fs = 0, fl = 0, bs = 0, bl = 0, hl = 0, fbS, fbL } = {}) => ({
  tsHour: BASE_S + h * 3600, f_short: fs, f_long: fl, b_short: bs, b_long: bl, hl_rate: hl,
  ...(fbS === undefined ? null : { fbase_short: fbS }),
  ...(fbL === undefined ? null : { fbase_long: fbL }),
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Формула
// ─────────────────────────────────────────────────────────────────────────────

test("множитель: 1 при нулевом входе, 0.5 при S = B, строго убывает по размеру", () => {
  assert.equal(dilutionFactor(1e6, 0), 1, "нулевой вход рынок не замечает");
  assert.equal(dilutionFactor(1e6, 1e6), 0.5, "вход размером со всю базу режет ставку вдвое");
  let prev = 1;
  for (const s of [1, 10, 1e3, 1e5, 1e7, 1e9]) {
    const f = dilutionFactor(1e6, s);
    assert.ok(f < prev, `множитель обязан убывать: при S=${s} получено ${f}, предыдущее ${prev}`);
    assert.ok(f > 0 && f < 1, `множитель обязан лежать в (0,1): ${f}`);
    prev = f;
  }
});

test("нулевая или негодная база даёт НОЛЬ, а не единицу", () => {
  // Именно здесь погорел опровергнутый расчёт: `Math.max(b,0) + size` при нулевой базе давал
  // множитель 1, то есть полное удержание там, где платить некому и достаётся ноль.
  for (const b of [0, -1, NaN, undefined, null]) {
    assert.equal(dilutionFactor(b, 1000), 0, `база ${String(b)} обязана давать ноль удержания`);
  }
});

test("опорная пара BTC: верный множитель 0.999953, опровергнутый в 21 тысячу раз меньше", () => {
  const B = 2.11e7, S = 1000;
  const right = dilutionFactor(B, S);
  const wrong = refuted(B, S);
  near(right, 0.999953, 1e-6, "верный множитель B/(B+S)");
  near(wrong, 4.7e-5, 1e-6, "опровергнутый множитель S/(B+S)");
  near(right / wrong, 21100, 100, "отношение форм");
});

test("тождество GMX: сходится на согласованных базах и НЕ сходится на подменённой", () => {
  const fl = -2.2e-8, fs = 2.4e-8;
  const bl = 2.3e7;
  const bs = (Math.abs(fl) * bl) / Math.abs(fs); // база, при которой тождество выполнено точно
  const ok = potOf(fl, bl, fs, bs);
  assert.ok(ok.ok, `тождество обязано сойтись, невязка ${ok.relErr}`);
  near(ok.pot, Math.abs(fl) * bl, 1e-12, "поток рынка");
  const bad = potOf(fl, bl, fs, bs * 1.5); // подставлено соседнее поле: невязка 33%
  assert.equal(bad.ok, false, "подменённая база обязана быть замечена");
  assert.ok(bad.relErr > FA_IDENTITY_MAX_REL_ERR, `невязка ${bad.relErr} обязана превысить порог`);
});

test("база стороны читается из своего поля и не путается с борроу", () => {
  const r = row(0, { fs: 1e-8, fl: -1e-8, bs: 5e-9, bl: 5e-9, fbS: 111, fbL: 222 });
  assert.deepEqual(resolveBase(r, "short"), { bOwnUsd: 111, bOtherUsd: 222, ok: true, reason: null });
  assert.deepEqual(resolveBase(r, "long"), { bOwnUsd: 222, bOtherUsd: 111, ok: true, reason: null });
  const bare = row(0, { fs: 1e-8 });
  assert.equal(resolveBase(bare, "short").ok, false, "строки без баз это норма, а не ошибка формата");
  assert.equal(resolveBase(bare, "short").reason, "no_base");
});

test("ставка после разбавления: четыре причины и ни одной молчаливой", () => {
  assert.deepEqual(dilutedFundingRate(1e-8, 1e6, 0), { rate: 1e-8, factor: 1, reason: "no_size" });
  assert.deepEqual(dilutedFundingRate(-1e-8, 1e6, 1000), { rate: -1e-8, factor: 1, reason: "we_pay" });
  assert.deepEqual(dilutedFundingRate(1e-8, NaN, 1000), { rate: 0, factor: 0, reason: "no_base" });
  const d = dilutedFundingRate(1e-8, 1e6, 1e6);
  assert.equal(d.reason, "diluted");
  near(d.factor, 0.5, 1e-15, "множитель");
  near(d.rate, 5e-9, 1e-20, "ставка после разбавления");
  assert.equal(NO_DILUTION.factor, 1, "нейтральный результат обязан быть ровно единицей");
});

test("база приходит в неподвижной точке 1e30 и переводится в доллары", () => {
  near(baseUsd("22915569581582424001066011470299622408"), 2.2915569581582424e7, 1, "база BTC из снимка");
  assert.ok(Number.isNaN(baseUsd("не число")), "мусор обязан быть не числом, а не нулём");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Правила применения в леджере
// ─────────────────────────────────────────────────────────────────────────────

// Позиция и её неразбавляемый близнец на тех же строках: сравнение слоёв делается на одних данных.
function pair(rows, { config = "A", capital = 1000, hours = rows.length } = {}) {
  const mk = (dilute) => {
    const p = openPosition({ strategy: "two", instrumentKey: "T", config, capital, leverage: 1, nowMs: BASE_MS, dilute });
    accrueFromRows(p, rows, BASE_MS + hours * HOUR);
    closePosition(p, BASE_MS + hours * HOUR);
    return p;
  };
  return { on: mk(true), off: mk(false) };
}

test("правило 1: множитель применяется ПОЧАСОВО, а не средним по окну", () => {
  // Строки построены по тождеству от ПОСТОЯННОГО потока рынка pot: ставка получателя есть pot/B,
  // значит малая база несёт БОЛЬШУЮ ставку. Ровно поэтому деньги сидят в часах с самой малой базой,
  // где множитель самый жёсткий, и усреднение множителя по окну систематически завышает доход.
  // На равных ставках эффекта не было бы вовсе: умножение линейно, и среднее совпало бы почасовым.
  const pot = 1e-3; // доллар в секунду, один и тот же в обоих часах
  const bBig = 1e6, bSmall = 1e3;
  const rows = [
    row(0, { fs: pot / bBig, fl: -pot / bBig, fbS: bBig, fbL: bBig }),
    row(1, { fs: pot / bSmall, fl: -pot / bSmall, fbS: bSmall, fbL: bSmall }),
  ];
  const { on, off } = pair(rows, { capital: 1000 });
  const perHour = on.accruals.reduce((s, a) => s + a.fundingUsd, 0);
  const quoted = off.accruals.reduce((s, a) => s + a.fundingUsd, 0);
  const meanFactor = (dilutionFactor(bBig, 1000) + dilutionFactor(bSmall, 1000)) / 2;
  const windowed = quoted * meanFactor;
  near(perHour, 3600 * 1000 * (pot / bBig * dilutionFactor(bBig, 1000) + pot / bSmall * dilutionFactor(bSmall, 1000)),
    1e-9, "почасовая сумма");
  assert.ok(perHour < windowed, `усреднение обязано завышать: почасово ${perHour}, средним ${windowed}`);
  assert.ok(windowed / perHour > 1.4, `завышение обязано быть заметным, получено ${windowed / perHour}`);
});

test("правило 2: борроу и нога Hyperliquid не трогаются, побитово", () => {
  const rows = [
    row(0, { fs: 2e-8, fl: -2e-8, bs: 3e-9, bl: 4e-9, hl: 1e-5, fbS: 5000, fbL: 9000 }),
    row(1, { fs: 1e-8, fl: -1e-8, bs: 3e-9, bl: 4e-9, hl: 2e-5, fbS: 4000, fbL: 9000 }),
  ];
  const { on, off } = pair(rows, { capital: 5000 });
  for (let i = 0; i < rows.length; i++) {
    assert.equal(on.accruals[i].borrowUsd, off.accruals[i].borrowUsd, `борроу часа ${i} обязан совпасть побитово`);
    assert.equal(on.accruals[i].dPnlHl, off.accruals[i].dPnlHl, `нога HL часа ${i} обязана совпасть побитово`);
    assert.ok(on.accruals[i].fundingUsd < off.accruals[i].fundingUsd, `фандинг часа ${i} обязан уменьшиться`);
    // Сумма ноги GMX обязана оставаться суммой своих частей, иначе журнал операций разъедется с P&L.
    near(on.accruals[i].dPnlGmx, on.accruals[i].fundingUsd + on.accruals[i].borrowUsd, 1e-12, "части ноги GMX");
  }
});

test("правило 3: часы собственной уплаты не масштабируются вовсе", () => {
  // Конфигурация A держит короткую ногу GMX. f_short < 0 значит платим мы.
  const rows = [row(0, { fs: -4e-7, fl: 4e-7, fbS: 100, fbL: 1e6 })];
  const { on, off } = pair(rows, { capital: 10000 });
  assert.equal(on.accruals[0].fundingUsd, off.accruals[0].fundingUsd, "убыток обязан остаться прежним побитово");
  assert.equal(on.accruals[0].dilutionReason, "we_pay");
  assert.equal(on.accruals[0].dilutionFactor, 1);
  // Цена нарушения правила: масштабирование убытка стёрло бы 97% его величины в нашу пользу.
  const scaled = off.accruals[0].fundingUsd * dilutionFactor(100, 10000);
  assert.ok(scaled > off.accruals[0].fundingUsd, "масштабирование убытка сделало бы его меньше");
  near(1 - scaled / off.accruals[0].fundingUsd, 0.99, 0.01, "доля стёртого убытка");
});

test("запрет 1: плательщика определяет ЗНАК ставки, а не величина базы", () => {
  // Час 0: наша сторона МЕНЬШАЯ и при этом ПЛАТИТ. Правило «платит большая сторона» разбавило бы
  // этот час, то есть уменьшило бы наш убыток.
  // Час 1: наша сторона БОЛЬШАЯ и при этом ПОЛУЧАЕТ. То же неверное правило оставило бы час
  // неразбавленным, то есть завысило бы доход.
  const rows = [
    row(0, { fs: -3e-7, fl: 3e-7, fbS: 1000, fbL: 900000 }),
    row(1, { fs: 3e-7, fl: -3e-7, fbS: 900000, fbL: 1000 }),
  ];
  const { on, off } = pair(rows, { capital: 100000 });
  assert.equal(on.accruals[0].dilutionReason, "we_pay", "меньшая сторона тоже платит, и разбавления тут нет");
  assert.equal(on.accruals[0].fundingUsd, off.accruals[0].fundingUsd);
  assert.equal(on.accruals[1].dilutionReason, "diluted", "большая сторона тоже получает, и разбавление тут есть");
  near(on.accruals[1].dilutionFactor, dilutionFactor(900000, 100000), 1e-15, "множитель по нашей базе");
  assert.ok(on.accruals[1].fundingUsd < off.accruals[1].fundingUsd);
});

test("запрет 3: доход растёт СУБлинейно по размеру, опровергнутая форма даёт квадрат", () => {
  // Признак перевёрнутого множителя виден прямо в таблице: прибыль растёт квадратично по капиталу.
  // `S/(B+S) * S` это и есть квадрат, `B/(B+S) * S` насыщается.
  const rows = [row(0, { fs: 1e-6, fl: -1e-6, fbS: 20000, fbL: 20000 })];
  const grossAt = (cap) => {
    const { on } = pair(rows, { capital: cap });
    return on.accruals[0].fundingUsd;
  };
  const g1 = grossAt(10000);
  const g2 = grossAt(20000);
  assert.ok(g2 < 2 * g1, `верная форма обязана насыщаться: ${g2} против ${2 * g1}`);
  assert.ok(g2 > g1, "доход всё же обязан расти по размеру");
  const w1 = 1e-6 * 3600 * 10000 * refuted(20000, 10000);
  const w2 = 1e-6 * 3600 * 20000 * refuted(20000, 20000);
  assert.ok(w2 > 2 * w1, `опровергнутая форма обязана расти сверхлинейно: ${w2} против ${2 * w1}`);
});

test("базы на час нет: доход обнулён, издержки ноги остались, время названо", () => {
  const rows = [
    row(0, { fs: 2e-8, fl: -2e-8, bs: 5e-9, bl: 0, hl: 1e-5 }), // баз нет вовсе
    row(1, { fs: 2e-8, fl: -2e-8, bs: 5e-9, bl: 0, hl: 1e-5, fbS: 50000, fbL: 50000 }),
  ];
  const { on, off } = pair(rows, { capital: 1000 });
  assert.equal(on.accruals[0].dilutionReason, "no_base");
  assert.equal(on.accruals[0].fundingUsd, 0, "доход часа без базы обнулён");
  assert.equal(on.accruals[0].borrowUsd, off.accruals[0].borrowUsd, "борроу остался");
  assert.equal(on.accruals[0].dPnlHl, off.accruals[0].dPnlHl, "нога HL осталась");
  const s = positionSummary(on);
  near(s.noBaseSec, 3600, 1e-9, "время без базы названо");
  // Час без базы входит в знаменатель доли удержания: мы бы этот доход книжили, и теперь не книжим.
  assert.ok(s.dilutionRetained < dilutionFactor(50000, 1000), "доля удержания обязана учесть обнулённый час");
});

test("позиция без флага разбавления считается ровно как раньше, побитово", () => {
  const rows = [
    row(0, { fs: 2e-8, fl: -2e-8, bs: 3e-9, bl: 4e-9, hl: 1e-5, fbS: 1000, fbL: 2000 }),
    row(1, { fs: -1e-8, fl: 1e-8, bs: 3e-9, bl: 4e-9, hl: 1e-5, fbS: 1000, fbL: 2000 }),
  ];
  const p = openPosition({ strategy: "two", instrumentKey: "T", config: "A", capital: 1000, leverage: 1, nowMs: BASE_MS });
  accrueFromRows(p, rows, BASE_MS + 2 * HOUR);
  assert.equal(p.dilute, false, "умолчание обязано быть выключенным");
  p.accruals.forEach((a, i) => {
    assert.equal(a.dilutionReason, undefined, "полей разбавления у обычной позиции быть не должно");
    assert.equal(a.fundingQuotedUsd, undefined);
    // Выражения те же, что до появления правила, и сверяются ТОЧНЫМ равенством, а не допуском:
    // (f-b)*dt*N и f*dt*N + (-b)*dt*N дают разный последний бит, а книги охраны сверяются побайтово.
    assert.equal(a.dPnlGmx, (rows[i].f_short - rows[i].b_short) * 3600 * 1000, `нога GMX часа ${i}`);
    assert.equal(a.fundingUsd, rows[i].f_short * 3600 * 1000, `фандинг часа ${i}`);
    assert.equal(a.borrowUsd, a.dPnlGmx - a.fundingUsd, `борроу часа ${i} это точное дополнение`);
  });
  const s = positionSummary(p);
  assert.equal(s.dilutionRetained, null, "доли удержания у неразбавляемой позиции нет, и 100% показывать нельзя");
  assert.equal(s.flowQuoted, 0);
});

test("живая ветка начисления разбавляет так же, как историческая", () => {
  const snap = { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 0, hl_rate: 0, fbase_short: 3000, fbase_long: 9000 };
  const live = openPosition({ strategy: "two", instrumentKey: "T", config: "A", capital: 1000, leverage: 1, nowMs: BASE_MS, dilute: true });
  accrue(live, snap, BASE_MS + HOUR);
  const hist = openPosition({ strategy: "two", instrumentKey: "T", config: "A", capital: 1000, leverage: 1, nowMs: BASE_MS, dilute: true });
  accrueFromRows(hist, [row(0, { fs: 1e-8, fl: -1e-8, fbS: 3000, fbL: 9000 })], BASE_MS + HOUR);
  assert.equal(live.accruals[0].fundingUsd, hist.accruals[0].fundingUsd, "два пути обязаны дать одно число");
  assert.equal(live.accruals[0].dilutionFactor, hist.accruals[0].dilutionFactor);
  near(live.accruals[0].dilutionFactor, 3000 / 4000, 1e-15, "множитель живой ветки");
});

test("размер разбавления это НОЦИОНАЛ, а не капитал", () => {
  // При плече 5 в базу рынка входит $5000, а не $1000: считать по капиталу значило бы тем меньше
  // разбавления, чем сильнее мы на самом деле давим на рынок.
  const rows = [row(0, { fs: 1e-8, fl: -1e-8, fbS: 5000, fbL: 5000 })];
  const p = openPosition({ strategy: "two", instrumentKey: "T", config: "A", capital: 1000, leverage: 5, nowMs: BASE_MS, dilute: true });
  accrueFromRows(p, rows, BASE_MS + HOUR);
  near(p.accruals[0].dilutionFactor, dilutionFactor(5000, 5000), 1e-15, "множитель по ноционалу");
});

test("сводка счёта складывает потоки, а не усредняет доли", () => {
  const mk = (fbS, capital) => {
    const p = openPosition({ strategy: "two", instrumentKey: `T${fbS}`, config: "A", capital, leverage: 1, nowMs: BASE_MS, dilute: true });
    accrueFromRows(p, [row(0, { fs: 1e-6, fl: -1e-6, fbS, fbL: fbS })], BASE_MS + HOUR);
    closePosition(p, BASE_MS + HOUR);
    return p;
  };
  const small = mk(1000, 1000); // крошечный рынок, удержание 50%
  const big = mk(1e9, 100000); // огромный рынок, удержание почти 100%
  const acc = accountSummary([small, big]);
  const sSmall = positionSummary(small);
  const sBig = positionSummary(big);
  near(acc.flowQuoted, sSmall.flowQuoted + sBig.flowQuoted, 1e-9, "знаменатель складывается");
  near(acc.dilutionRetained, acc.flowReceived / acc.flowQuoted, 1e-15, "доля считается от сумм");
  const naive = (sSmall.dilutionRetained + sBig.dilutionRetained) / 2;
  assert.ok(Math.abs(acc.dilutionRetained - naive) > 0.1, "среднее долей дало бы другое число, и это не то число");
});

test("журнал операций сходится с P&L и у разбавляемой позиции", () => {
  // Тождество журнала (последний остаток равен netPnl) держится на том, что нога GMX равна сумме
  // своих частей. Разбавление меняет фандинг и не трогает борроу, поэтому сумму надо пересобирать
  // заново, а не наследовать от котируемой: ошибка тут разошлась бы между экраном и итогом счёта.
  const rows = [
    row(0, { fs: 3e-7, fl: -3e-7, bs: 4e-9, bl: 2e-9, hl: 1e-5, fbS: 8000, fbL: 20000 }),
    row(1, { fs: -2e-7, fl: 2e-7, bs: 4e-9, bl: 2e-9, hl: -2e-5, fbS: 8000, fbL: 20000 }),
  ];
  const p = openPosition({ strategy: "two", instrumentKey: "T", config: "A", capital: 4000, leverage: 1,
    nowMs: BASE_MS, roundTripCost: 12.5, dilute: true });
  accrueFromRows(p, rows, BASE_MS + 2 * HOUR);
  closePosition(p, BASE_MS + 2 * HOUR);
  const ev = buildLedger(p);
  const rec = ledgerReconciles(p, ev);
  assert.ok(rec.ok, `журнал обязан сойтись с P&L: ${JSON.stringify(rec)}`);
  near(ev[ev.length - 1].runningBalance, positionSummary(p).netPnl, 1e-9, "последний остаток равен нетто");
  // Разбавление обязано быть видно в самом журнале, а не только в сводке.
  const funding = ev.filter((e) => e.type === "gmx_funding");
  assert.equal(funding.length, 2);
  assert.ok(funding[0].amount < rows[0].f_short * 3600 * 4000, "час получения обязан быть урезан");
  assert.equal(funding[1].amount, rows[1].f_short * 3600 * 4000, "час уплаты обязан остаться прежним");
});

test("живой снимок несёт базы фандинга обеих сторон", () => {
  const gmx = {
    marketToken: "0x1", name: "ETH/USD", indexToken: "0x2",
    factors: { f_long: -1e-8, f_short: 1e-8, b_long: 1e-9, b_short: 1e-9 },
    oiLongUsd: 1.2e7, oiShortUsd: 9e6, gate: { ok: true, shortRelErr: 0, longRelErr: 0 },
  };
  const hl = { hl_rate: 1e-5, hl_premium: 0, markPx: 3000, maxLev: 25 };
  const snap = buildSnapshot({ key: "ETH", token: "ETH", hlCoin: "ETH" }, gmx, hl);
  assert.equal(snap.raw.fbase_long, 1.2e7);
  assert.equal(snap.raw.fbase_short, 9e6);
  // Отсутствие баз НЕ обязано останавливать начисление: разбавление это отдельный слой, и его
  // деградация называется своей причиной, а не гасит всю позицию.
  assert.equal(snap.accrualOk, true);
});
