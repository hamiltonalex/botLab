// fa-slice.test.js - СРЕЗ ВСЕЛЕННОЙ ДЛЯ ПРАВИЛ (`fa/slice.js`) НА ПОЛУСОТНЕ ИНСТРУМЕНТОВ.
//
// ЧТО ЗДЕСЬ ЛОВИТСЯ ПАДАЮЩИМ ТЕСТОМ. Фаза 3 расширения вселенной меняет ОДНУ вещь: откуда берётся
// список инструментов для среза. Правило при этом не трогается ни строкой, значит и проверять надо
// не экономику, а то, что срез на полусотне инструментов правило ПРИНИМАЕТ и что живые ворота
// данных остаются единственным, чем он отличается от среза без них.
//
// ─────────────────────────────────────────────────────────────────────────────
// ПОЧЕМУ ЗДЕСЬ НЕТ ЧИСЕЛ ОТЧЁТА ($559.11 нетто, 22 перекладки), И ЭТО НЕ ЛЕНЬ
// ─────────────────────────────────────────────────────────────────────────────
//
// Приёмка плана требовала воспроизвести эти числа офлайн-прогоном. Прогон их воспроизводит ТОЧНО,
// но говорит он о СТЕНДЕ, а не о приложении: срез стенда (`sliceAt`) и срез приложения различаются
// ПО ПОСТРОЕНИЮ, и оба различия названы кодом.
//
//   | что            | стенд                                  | приложение                          |
//   | ворота стакана | полей `bookMissing`/`bookAgeSec` НЕТ   | стакан живой и обязательный         |
//   | кривая удара   | `impactFor(token, gmxSide)` снимка     | `impact.gmxNodes: []`, пусто        |
//   | имя рынка      | голый токен `APT`                      | ключ инструмента `APT-arb-ethusdc`  |
//
// Значит совпадения чисел надо не добиваться, а БОЯТЬСЯ: оно означало бы, что срез приложения
// потерял ворота стакана. Предмет проверки отсюда ПАРИТЕТ ФОРМЫ, и он проверяется тестом, а не
// прогоном.
//
// ЧИСЛОВАЯ ПРИЁМКА СТОИТ НА ФИКСТУРАХ, А НЕ НА ЖИВОМ СОСТАВЕ. Три замера одного дня 16.09 дали
// 49 рынков отбора (фикстура 10:33Z), 48 (живьём 17:33Z) и 46 (живьём 18:40Z): открытый интерес
// двигается, и рынки ходят через порог доли. Тест, зашивший живое число, падал бы через час.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFaSlice, faSliceRow } from "../src/engine/fa/slice.js";
import {
  FA_UNIVERSE_DEFAULTS, selectUniverse, resolveUniverse, schemeOf,
} from "../src/engine/fa/universe-scan.js";
import { ALL_MARKETS } from "../src/engine/universe.js";
import { sizeUniverse, FA_SIZING_DEFAULTS } from "../src/engine/fa/sizing.js";
import { armAuto, autoTick, createAutoState } from "../src/engine/fa/auto.js";
import { DEFAULT_COSTS } from "../src/engine/costs.js";
import { annualizeRow, scanTwoLeg } from "../src/engine/math.js";
import { hour } from "./fa-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));
const MARKETS = { arbitrum: fx("markets-info-arbitrum.json").markets, avalanche: fx("markets-info-avalanche.json").markets };
const HL = fx("hl-meta.json").universe;
const AT = Date.UTC(2026, 8, 16, 10, 33);
const H = FA_SIZING_DEFAULTS.horizonH;
const T = 1.7e12;
const BOOT = T - 3600000;
const GMX_AT = T - 20000; // базы свежие: ворота возраста баз к предмету этого файла отношения не имеют

// ЖИВОЙ СПИСОК ПРИЛОЖЕНИЯ на фикстуре 16.09: 49 рынков отбора, из них три под ключами запаса, плюс
// пять инструментов запаса = 51. Ровно тот список, который фаза 3 подаёт в срез.
const scan = selectUniverse({ marketsByChain: MARKETS, hlCoins: HL, cfg: { ...FA_UNIVERSE_DEFAULTS }, asOfMs: AT });
const INSTRUMENTS = resolveUniverse({ scan, saved: null, fallback: ALL_MARKETS, held: [] }).instruments;

// ── Снабжение среза. Четыре разных потока рынка, розданные по кругу ПО НОМЕРУ в списке: одинаковая
// экономика у всех инструментов сделала бы неразличимыми перепутанные строки, а именно их тест и
// обязан ловить. Три потока правило финансирует, четвёртый (200) отказывает по экономике - без
// такого отказа нельзя отличить «ворота стакана» от «рынок и без них не считается».
const POTS = [8000, 4000, 1500, 200];
const ROWS = POTS.map((P) => Array.from({ length: H }, (_, h) => hour(h, { pot: P / (3600 * H), bShort: 1e5, bLong: 1e12 })));
const indexOfInst = new Map(INSTRUMENTS.map((i, n) => [i.key, n]));
const rowsOf = (inst) => ROWS[indexOfInst.get(inst.key) % ROWS.length];

const NODES = [{ sizeUsd: 1000, bps: 0.4 }, { sizeUsd: 10000, bps: 0.8 }, { sizeUsd: 100000, bps: 2.2 }, { sizeUsd: 500000, bps: 7.5 }];
const snapOf = (inst) => {
  const last = rowsOf(inst).at(-1);
  return {
    chosen: "A", price: 100, hlMaxLev: 25, dataComplete: true, gateOk: true,
    avail: { longUsd: 5e6, shortUsd: 5e6 },
    raw: {
      fbase_long: last.fbase_long, fbase_short: last.fbase_short,
      f_long: last.f_long, f_short: last.f_short, b_long: 0, b_short: 0, hl_rate: 0,
    },
  };
};
const bookOf = (ageSec = 1) => ({ at: T - ageSec * 1000, slip: { visibleNtl: 4e6, exhaustedFrom: null, nodes: NODES } });

// ТРИ КЛАССА СТАКАНА, розданные по кругу, потому что живые ворота проверяются только тем, что они
// кого-то ОТСЕИВАЮТ: свежий, протухший (старше `bookMaxAgeSec` = 30 с) и отсутствующий вовсе.
const BOOK_FRESH = 0; const BOOK_STALE = 1; const BOOK_NONE = 2;
const bookClassOf = (inst) => indexOfInst.get(inst.key) % 3;
const liveBookOf = (inst) => {
  const cls = bookClassOf(inst);
  if (cls === BOOK_NONE) return null;
  return bookOf(cls === BOOK_STALE ? 120 : 1);
};

const sliceOf = ({ bookFor = liveBookOf, instruments = INSTRUMENTS } = {}) => buildFaSlice({
  instruments, nowMs: T, gmxAt: GMX_AT, windowH: H,
  snapshotOf: snapOf, bookOf: bookFor, rowsOf: (inst) => rowsOf(inst),
});

// ТОТ ЖЕ СРЕЗ БЕЗ ЖИВЫХ ВОРОТ. Снимается ровно два поля - те, которых нет у среза стенда. Всё
// остальное, включая пустую кривую удара GMX и пустые узлы стакана у рынка без стакана, остаётся
// как было: иначе сравнивались бы два разных среза, а не один срез с воротами и без них.
const withoutBookGate = (slice) => slice.map((m) => {
  const live = { ...m.live };
  delete live.bookMissing;
  delete live.bookAgeSec;
  return { ...m, live };
});

const CFG = { ...FA_SIZING_DEFAULTS, ticketCapUsd: Math.min(FA_SIZING_DEFAULTS.ticketCapUsd, 2500) };
const run = (slice) => sizeUniverse({ markets: slice, costs: DEFAULT_COSTS, capitalTotal: 1e9, cfg: CFG });

// ─────────────────────────────────────────────────────────────────────────────
// 1. СРЕЗ НА ПОЛУСОТНЕ ИНСТРУМЕНТОВ ПРАВИЛО ПРИНИМАЕТ
// ─────────────────────────────────────────────────────────────────────────────

test("живой список фикстуры даёт 51 инструмент, и столько же строк уходит в срез", () => {
  assert.equal(INSTRUMENTS.length, 51);
  const slice = sliceOf();
  assert.equal(slice.length, 51);
  // Порядок строк это порядок списка: переставленный срез в записи решения выглядел бы сменой состава.
  assert.deepEqual(slice.map((m) => m.token), INSTRUMENTS.map((i) => i.key));
});

test("`sizeUniverse` принимает срез приложения целиком: кривая на КАЖДЫЙ инструмент, ни одной потери", () => {
  const u = run(sliceOf());
  assert.equal(u.curves.length, 51);
  assert.deepEqual(u.curves.map((c) => c.token), INSTRUMENTS.map((i) => i.key));
  // И4: рынок либо профинансирован, либо несёт КОД ОТКАЗА. Третьего состояния нет.
  for (const c of u.curves) {
    if (c.refusal) { assert.equal(c.sizeUsd, null, c.token); continue; }
    assert.ok(c.sizeUsd > 0, `${c.token}: профинансирован без размера`);
    assert.ok(Number.isFinite(c.netUsd), `${c.token}: профинансирован без нетто`);
  }
  assert.ok(u.curves.some((c) => !c.refusal), "ни один из 51 инструмента не профинансирован: срез правилу не годится");
});

test("КЛЮЧ ИНСТРУМЕНТА ДОХОДИТ ДО ПРАВИЛА БУКВА В БУКВУ, а не приведённым к токену (И2)", () => {
  const slice = sliceOf();
  const u = run(slice);
  // Ключ вида `APT-arb-ethusdc` содержит дефисы, и любое приведение к символу схлопнуло бы рынки
  // одного символа в один: у BTC на Arbitrum рынков ТРИ, и два из них исчезли бы молча.
  const keys = u.curves.map((c) => c.token);
  assert.equal(new Set(keys).size, keys.length, "ключи в срезе не уникальны: снимки затрут друг друга");
  for (const inst of ALL_MARKETS) assert.ok(keys.includes(inst.key), `ключ запаса ${inst.key} пропал из среза`);
  assert.ok(keys.some((k) => k.includes("-arb-") || k.includes("-avax-")), "в срезе нет ни одного нового рынка");
});

test("схема каждой строки взята у `schemeOf`, и одноногие идут БЕЗ конфигурации", () => {
  for (const m of sliceOf()) {
    const inst = INSTRUMENTS.find((i) => i.key === m.token);
    assert.equal(m.strategy, schemeOf(inst), `${m.token}: схема строки разошлась со схемой инструмента`);
    if (m.strategy === "one") assert.equal(m.config, null, `${m.token}: у одноногой строки появилась нога GMX`);
    else assert.ok(["A", "B"].includes(m.config), `${m.token}: двуногая строка без конфигурации`);
  }
  // Новый рынок ТОЛЬКО двуногий (решение фазы 2), одноногих ровно три, и все три из запаса.
  const ones = sliceOf().filter((m) => m.strategy === "one").map((m) => m.token);
  assert.deepEqual(ones.sort(), ["BTC-Arb", "ETH-Arb", "ETH-Avax"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ПАРИТЕТ ФОРМЫ: ЖИВЫЕ ВОРОТА СТАКАНА - ЕДИНСТВЕННОЕ ОТЛИЧИЕ ОТ СРЕЗА БЕЗ НИХ (Л1)
// ─────────────────────────────────────────────────────────────────────────────

test("рынок со СВЕЖИМ стаканом даёт ПОБИТОВО ту же кривую, что и он же без живых ворот", () => {
  const slice = sliceOf();
  const withGate = run(slice);
  const withoutGate = run(withoutBookGate(slice));
  let checked = 0;
  for (let i = 0; i < slice.length; i += 1) {
    if (bookClassOf(INSTRUMENTS[i]) !== BOOK_FRESH) continue;
    checked += 1;
    assert.deepEqual(withGate.curves[i], withoutGate.curves[i], `${slice[i].token}: ворота сдвинули кривую рынка, который их прошёл`);
  }
  assert.ok(checked >= 10, `рынков со свежим стаканом всего ${checked}: проверять нечего`);
});

test("коды `no_book` и `stale_book` приходят ТОЛЬКО от живых ворот, и без них взяться им неоткуда", () => {
  const slice = sliceOf();
  const withGate = run(slice);
  const withoutGate = run(withoutBookGate(slice));
  const seen = { no_book: 0, stale_book: 0, funded: 0 };
  for (let i = 0; i < slice.length; i += 1) {
    const cls = bookClassOf(INSTRUMENTS[i]);
    if (cls === BOOK_FRESH) continue;
    const code = cls === BOOK_NONE ? "no_book" : "stale_book";
    assert.equal(withGate.curves[i].refusal, code, `${slice[i].token}: ожидался отказ ${code}`);
    seen[code] += 1;
    // БЕЗ ВОРОТ КОДА СТАКАНА НЕТ НИ У КОГО. Рынок при этом волен отказаться по ЭКОНОМИКЕ: это его
    // право и к воротам отношения не имеет. Утверждение здесь ровно одно - код стакана приходит
    // ТОЛЬКО от ворот, и без них взяться ему неоткуда.
    assert.ok(!["no_book", "stale_book"].includes(withoutGate.curves[i].refusal),
      `${slice[i].token}: без живых ворот всё равно отказан по стакану (${withoutGate.curves[i].refusal})`);
    if (!withoutGate.curves[i].refusal) seen.funded += 1;
  }
  assert.ok(seen.no_book > 0 && seen.stale_book > 0, `ворота не сработали ни разу: ${JSON.stringify(seen)}`);
  // Непустота: если без ворот не профинансировался НИ ОДИН из отсечённых, тест доказывал бы только
  // то, что эти рынки не считаются вовсе.
  assert.ok(seen.funded > 0, "ни один отсечённый воротами рынок без них не профинансирован");
});

test("СОВПАДЕНИЕ СО СРЕЗОМ СТЕНДА БЫЛО БЫ ДЕФЕКТОМ: ворота обязаны кого-то отсеять", () => {
  const withGate = run(sliceOf());
  const withoutGate = run(withoutBookGate(sliceOf()));
  const fundedWith = withGate.curves.filter((c) => !c.refusal).length;
  const fundedWithout = withoutGate.curves.filter((c) => !c.refusal).length;
  assert.ok(fundedWithout > fundedWith,
    `профинансировано с воротами ${fundedWith}, без ворот ${fundedWithout}: срез потерял ворота стакана`);
});

test("стакан у ВСЕХ свежий - отличий нет вовсе, и это граница того же утверждения", () => {
  const slice = sliceOf({ bookFor: () => bookOf(1) });
  assert.deepEqual(run(slice).curves, run(withoutBookGate(slice)).curves);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. УДЕРЖИВАЕМЫЙ РЫНОК, НЕ ПРОШЕДШИЙ ВОРОТА ДАННЫХ (Л5)
// ─────────────────────────────────────────────────────────────────────────────
//
// Фаза 2 закрыла ПЕРВОЕ условие: удерживаемый инструмент прикреплён к списку и в срез попадает.
// ВТОРОЕ условие ею не закрыто: попав в срез, рынок ещё обязан пройти `dataGate`, а при полусотне
// рынков потерять стакан своей монеты шансов больше, чем при пяти.
//
// ЧТО ВЫЯСНИЛОСЬ ЗАМЕРОМ, И ЭТО НАДО ЗНАТЬ ВЛАДЕЛЬЦУ. Брутто удержания (`holdGross`) стакана НЕ
// ТРЕБУЕТ ВООБЩЕ: оно считается по одним часовым строкам, потому что удар это издержка СДЕЛКИ, а
// не начисление. Значит потеря стакана своей монеты удержание не ослепляет и сравнение не портит.
// Теряется ровно одно: ПЕРЕКЛАДКА В ТОТ ЖЕ РЫНОК ДРУГИМ РАЗМЕРОМ, потому что она проходит через
// правило входа и там честно отказывается кодом `no_book`.

const armed = () => {
  const st = armAuto(createAutoState({ nowMs: BOOT }), { nowMs: BOOT });
  st.lastTickAt = T - 300000;
  st.uptime = { ticks: 10, firstAt: BOOT, lastAt: st.lastTickAt, maxGapMs: 300000, gaps: [], nominalSec: 300 };
  st.positionId = "p1";
  return st;
};
const HELD = "ETH";
const position = () => ({
  id: "p1", token: HELD, config: "A", strategy: "two", sizeUsd: 2500,
  entryPx: 100, markPx: 100, hlMaxLev: 25, cumUsd: 0, peakUsd: 0, roundTripUsd: 8.75,
});
// Срез удержания: у ВСЕХ стакан свежий, кроме того рынка, который назван. Так меняется ровно одна
// переменная - стакан удерживаемой монеты.
const heldSlice = (blindKey) => sliceOf({ bookFor: (inst) => (inst.key === blindKey ? null : bookOf(1)) });
const tickOn = (slice) => autoTick({
  now: T, bootAt: BOOT, state: armed(), markets: slice, position: position(), nominalSec: 300,
});

test("удерживаемый рынок БЕЗ стакана: тик доходит до правила выхода, а не падает и не молчит", () => {
  const tick = tickOn(heldSlice(HELD));
  assert.ok(tick.decided, "тик не дошёл до решения");
  assert.ok(tick.exit, "правила выхода не было");
  assert.notEqual(tick.exit.action, "defer", `правило отложило решение: ${tick.exit.reason}`);
});

test("удерживаемый рынок БЕЗ стакана: брутто удержания СЧИТАЕТСЯ, потому что стакана оно не требует", () => {
  const blind = tickOn(heldSlice(HELD));
  const sighted = tickOn(heldSlice(null));
  assert.ok(Number.isFinite(blind.exit.holdGrossUsd), "брутто удержания не посчитано");
  // Число ТО ЖЕ, что и со стаканом: удержание не платит круг, значит удар в него не входит.
  assert.equal(blind.exit.holdGrossUsd, sighted.exit.holdGrossUsd);
});

test("удерживаемый рынок БЕЗ стакана несёт СВОЙ код отказа в кривых, а не исчезает (И4)", () => {
  const tick = tickOn(heldSlice(HELD));
  const own = tick.universe.curves.find((c) => c.token === HELD);
  assert.ok(own, "собственный рынок пропал из кривых правила входа");
  assert.equal(own.refusal, "no_book");
  // ПЕРЕКЛАДКА В СЕБЯ НЕВОЗМОЖНА, пока стакана нет, и это единственное, что теряется.
  assert.ok(!(tick.exit.best && tick.exit.best.token === HELD), "перекладка в рынок без стакана предложена");
});

test("удерживаемый рынок со СВЕЖИМ стаканом перекладку в себя предложить МОЖЕТ: сравнивать есть с чем", () => {
  const own = tickOn(heldSlice(null)).universe.curves.find((c) => c.token === HELD);
  assert.equal(own.refusal, null, "рынок со стаканом всё равно отказан: тогда предыдущий тест ничего не доказывает");
});

test("потеря стакана СВОЕЙ монеты не запрещает перекладку в ЧУЖОЙ рынок, и это поведение названо, а не случайно", () => {
  const tick = tickOn(heldSlice(HELD));
  // Альтернативы со свежими стаканами считаются как обычно: слепота собственного рынка их не касается.
  const alts = tick.universe.curves.filter((c) => c.token !== HELD && !c.refusal);
  assert.ok(alts.length > 0, "ни одной годной альтернативы: утверждение непроверяемо");
  assert.ok(["hold", "switch", "close"].includes(tick.exit.action));
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. СТРОКА СРЕЗА ПО ОТДЕЛЬНОСТИ
// ─────────────────────────────────────────────────────────────────────────────

test("возраст стакана и возраст баз меряются от РАЗНЫХ меток и не подменяют друг друга", () => {
  const inst = INSTRUMENTS[0];
  const m = faSliceRow({ inst, snap: snapOf(inst), book: bookOf(7), rows: rowsOf(inst), nowMs: T, gmxAt: GMX_AT });
  assert.equal(m.live.bookAgeSec, 7);
  assert.equal(m.live.baseAgeSec, 20);
  assert.equal(m.live.bookMissing, false);
});

test("нет снимка - строка всё равно есть, и правило отказывает ей ПО ДАННЫМ, а не падает", () => {
  const inst = INSTRUMENTS[0];
  const m = faSliceRow({ inst, snap: null, book: bookOf(1), rows: rowsOf(inst), nowMs: T, gmxAt: GMX_AT });
  assert.equal(m.token, inst.key);
  assert.equal(m.markPx, null);
  assert.equal(m.directionKnown, schemeOf(inst) === "one");
  const u = run([m]);
  assert.equal(u.curves.length, 1);
  assert.equal(u.curves[0].refusal, "no_base");
});

test("нет кадра истории - рынок для правила не существует, и отсеивают его ворота покрытия автомата", () => {
  const inst = INSTRUMENTS.find((i) => schemeOf(i) === "two");
  const m = faSliceRow({ inst, snap: snapOf(inst), book: bookOf(1), rows: [], nowMs: T, gmxAt: GMX_AT });
  assert.deepEqual(m.rows, []);
  const tick = autoTick({ now: T, bootAt: BOOT, state: armed(), markets: [m], position: null, nominalSec: 300 });
  assert.ok(tick.refusals.some((r) => r.code === "hist_short"), "рынок без кадра прошёл ворота покрытия");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4а. СТОРОНА НОГИ ВЫБИРАЕТСЯ ПО ОКНУ, А НЕ ПО МГНОВЕННОЙ СТРОКЕ ОПРОСА
//
// Находка 2 аудита механики 18.09. Живой бот исполнял НЕ ТО правило, которое стерегут шесть книг:
// они выбирают сторону `scanTwoLeg` по окну оценки, а срез брал её из одной мгновенной строки
// снимка. Цена -$15.33 нетто за год и минус 27% профинансированных рынков на срез. Ни одна
// проверка проекта увидеть этого не могла: книги этот код не трогают вовсе, а тест ниже до правки
// подавал сторону фикстурой и проверял её ПРОНОС.
// ─────────────────────────────────────────────────────────────────────────────

// Кадр, на котором два критерия РАСХОДЯТСЯ: 719 часов получает короткая сторона (схема A), а в
// последний час платит она же, и по последней строке выигрывает схема B. Расхождение не
// назначается словами, а доказывается ниже теми же функциями, которыми считают книги и снимок.
const DIVERGING = Array.from({ length: H }, (_, h) =>
  hour(h, { pot: 4000 / (3600 * H), bShort: 1e5, bLong: 1e12, recv: h === H - 1 ? "long" : "short" }));

// Снимок ТОГО ЖЕ кадра, со стороной, посчитанной по последней строке: ровно то, что кладёт в
// `chosen` функция `buildSnapshot` (`assemble.js`, `a.net_A >= a.net_B`).
const divergingSnap = () => {
  const last = DIVERGING.at(-1);
  const a = annualizeRow(last);
  return {
    chosen: a.net_A >= a.net_B ? "A" : "B", price: 100, hlMaxLev: 25, dataComplete: true, gateOk: true,
    avail: { longUsd: 5e6, shortUsd: 5e6 },
    raw: {
      fbase_long: last.fbase_long, fbase_short: last.fbase_short,
      f_long: last.f_long, f_short: last.f_short, b_long: 0, b_short: 0, hl_rate: 0,
    },
  };
};

test("кадр расхождения: окно выбирает A, мгновенная строка B, и оба факта доказаны, а не назначены", () => {
  const a = annualizeRow(DIVERGING.at(-1));
  assert.ok(a.net_B > a.net_A, "мгновенная строка обязана выбирать B, иначе тест ниже ничего не ловит");
  assert.equal(divergingSnap().chosen, "B", "снимок считает сторону той же формулой, что `assemble.js`");
  assert.equal(scanTwoLeg(DIVERGING).chosen, "A", "а средняя по окну обязана выбирать A");
});

test("СРЕЗ БЕРЁТ ОКОННУЮ СТОРОНУ, и базы едут за ней, а не за снимком", () => {
  const inst = INSTRUMENTS.find((i) => schemeOf(i) === "two");
  const m = faSliceRow({ inst, snap: divergingSnap(), book: bookOf(1), rows: DIVERGING, nowMs: T, gmxAt: GMX_AT, windowH: H });
  assert.equal(m.config, "A", "срез обязан взять сторону окна: это критерий книг, стендов и SPEC 1.2");
  assert.equal(m.config, scanTwoLeg(DIVERGING.slice(-H)).chosen, "и взять её ТЕМ ЖЕ расчётом, а не своей копией");
  assert.equal(m.directionKnown, true, "сторона подтверждена окном");
  // База СВОЕЙ стороны зависит от выбора: у схемы A нога GMX короткая, и своя база это fbase_short.
  // Мгновенная сторона B дала бы здесь 1e12, то есть правило считало бы разбавление по чужой базе.
  assert.equal(m.live.bOwnUsd, 1e5);
  assert.equal(m.live.bOtherUsd, 1e12);
  // И обратная сторона: без окна срез падает на мгновенную строку, и это ПРЕЖНЕЕ поведение.
  const noWindow = faSliceRow({ inst, snap: divergingSnap(), book: bookOf(1), rows: DIVERGING, nowMs: T, gmxAt: GMX_AT });
  assert.equal(noWindow.config, "B", "без окна сторона берётся из снимка");
  assert.equal(noWindow.directionKnown, false, "и это ВИДНО: выбор A/B не подтверждён");
  assert.equal(noWindow.live.bOwnUsd, 1e12, "вместе со стороной уезжает и база");
});

test("кадр короче окна: сторона падает на снимок, и запасной путь НАЗВАН", () => {
  const inst = INSTRUMENTS.find((i) => schemeOf(i) === "two");
  const short = DIVERGING.slice(-100);
  const m = faSliceRow({ inst, snap: divergingSnap(), book: bookOf(1), rows: short, nowMs: T, gmxAt: GMX_AT, windowH: H });
  assert.equal(m.config, "B", "окна нет: сторона из снимка, выдумывать её нельзя");
  assert.equal(m.directionKnown, false);
  // Такой рынок до правила всё равно не доходит: его отсеивают ворота покрытия автомата.
  const tick = autoTick({ now: T, bootAt: BOOT, state: armed(), markets: [m], position: null, nominalSec: 300 });
  assert.ok(tick.refusals.some((r) => r.code === "hist_short"), "рынок короче окна прошёл ворота покрытия");
  // Ни снимка, ни кадра: сторона это «A» по умолчанию, и она тоже НЕ подтверждена.
  const blind = faSliceRow({ inst, snap: null, book: bookOf(1), rows: [], nowMs: T, gmxAt: GMX_AT, windowH: H });
  assert.equal(blind.config, "A");
  assert.equal(blind.directionKnown, false);
});

test("сторона живого тракта считается ТЕМ ЖЕ выбирателем, что у книг: рукописной копии нет", () => {
  const src = readFileSync(join(HERE, "..", "src", "engine", "fa", "slice.js"), "utf8");
  assert.match(src, /import \{ scanTwoLeg \} from "\.\.\/math\.js"/, "выбиратель обязан входить ссылкой");
  assert.match(src, /scanTwoLeg\(all\.slice\(all\.length - windowH\)\)/, "сторона считается на окне, а не на всём кадре");
  // Сравнение `net_A >= net_B` это формула СНИМКА. Вторая её копия здесь означала бы возврат
  // мгновенного критерия под другим именем. Шапка формулу ЦИТИРУЕТ, поэтому проверяется код без
  // комментариев: иначе проверка ловила бы собственное объяснение.
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/net_A/.test(code), "сравнение мгновенных ставок вернулось в срез рукописной копией");
  // Окно не имеет права стоять здесь числом: оно приходит от замороженных параметров сделки.
  assert.ok(!/windowH\s*=\s*\d/.test(src), "рукописное окно в срезе: правка пресета развела бы сторону с брутто");
});

test("ТОЖДЕСТВО БАЗ сверяется живьём, а тождество ставок источника отказывает СВОИМ кодом", () => {
  // Находка 6.8 аудита механики 18.09: в поле `baseIdentityOk` ехал `snap.gateOk`, то есть совсем
  // другая проверка (тождество `netRate == funding + borrow` внутри ответа GMX). Оператору при сбое
  // знаков говорили «база пришла не та», а обещанной SPEC 3.3 защиты от подмены базы не было вовсе.
  const inst = INSTRUMENTS.find((i) => schemeOf(i) === "two");
  const rows = rowsOf(inst);

  // Здоровый рынок: оба тождества сходятся.
  const good = faSliceRow({ inst, snap: snapOf(inst), book: bookOf(1), rows, nowMs: T, gmxAt: GMX_AT, windowH: H });
  assert.equal(good.live.baseIdentityOk, true);
  assert.equal(good.live.srcPlausible, true);
  assert.equal(run([good]).curves[0].refusal, null, "здоровый рынок обязан финансироваться, иначе тест ничего не ловит");

  // ПОДМЕНА БАЗЫ: отношение сторон уехало на 20%, ставки те же. Именно так выглядит переключение
  // флага GMX `useOpenInterestInTokensForBalance`, от которого защита и обещана.
  const snap = snapOf(inst);
  const swapped = { ...snap, raw: { ...snap.raw, fbase_long: snap.raw.fbase_long * 1.2 } };
  const bad = faSliceRow({ inst, snap: swapped, book: bookOf(1), rows, nowMs: T, gmxAt: GMX_AT, windowH: H });
  assert.equal(bad.live.baseIdentityOk, false, "тождество баз обязано не сойтись");
  assert.equal(bad.live.srcPlausible, true, "а числа источника при этом сами с собой сходятся");
  assert.equal(run([bad]).curves[0].refusal, "base_identity_broken");

  // СБОЙ ТОЖДЕСТВА СТАВОК источника: базы верны, отказ другой и называется по-другому.
  const shaky = faSliceRow({ inst, snap: { ...snap, gateOk: false }, book: bookOf(1), rows, nowMs: T, gmxAt: GMX_AT, windowH: H });
  assert.equal(shaky.live.srcPlausible, false);
  assert.equal(shaky.live.baseIdentityOk, true, "базы не виноваты, и говорить про них нельзя");
  assert.equal(run([shaky]).curves[0].refusal, "src_implausible");

  // Отсутствие базы это ТРЕТЬЕ состояние, и тождество тут молчит: иначе «базы нет» уезжало бы
  // кодом «база пришла не та».
  const empty = faSliceRow({ inst, snap: { ...snap, raw: { ...snap.raw, fbase_short: undefined } }, book: bookOf(1), rows, nowMs: T, gmxAt: GMX_AT, windowH: H });
  assert.equal(empty.live.baseIdentityOk, true, "тождество не опровергнуто: проверять было нечем");
  assert.equal(run([empty]).curves[0].refusal, "no_base");
});

test("кривая удара GMX в срезе приложения ПУСТА у каждой строки: живого источника глубины нет", () => {
  for (const m of sliceOf()) assert.deepEqual(m.impact.gmxNodes, [], `${m.token}: откуда-то взялась кривая удара GMX`);
});
