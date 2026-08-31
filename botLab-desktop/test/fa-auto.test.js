// fa-auto.test.js - АВТОМАТ БОТА 1 (fa/auto.js): сбор кодов, приоритет решающего, ворота снабжения,
// сторож залога, каданс и намерение.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ, А ЧТО НЕТ. Не экономика правил: размер стережёт `fa-sizing.test.js`,
// выбор ветки `fa-exit.test.js`, запас до ликвидации `fa-margin.test.js`. Здесь проверяется ровно
// то, чего нет ни в одном из них: КАКОЙ код решает, когда сработало несколько, что ни один тик не
// молчит, и что ворота у входа и у удержания одни и те же.
//
// ДАННЫЕ СТРОИТ КОНСТРУКТОР `hour()` ИЗ `fa-helpers.mjs`: тождество `|f_long|*B_long =
// |f_short|*B_short` выполняется по построению. Рынка, где обе стороны котируют одну ставку при
// разных базах, не существует, и тест на таком рынке проверял бы не правило, а собственную выдумку.
//
// ТРИ КОНТРОЛЯ. Проверка, которая никогда не падала, не проверка, поэтому у трёх свойств здесь
// стоит рядом заведомо сломанный вариант, и тест требует, чтобы проверка его ПОЙМАЛА: тумблер, не
// переживший рестарт; молчаливый пропуск; ослабленные ворота выхода.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_COSTS } from "../src/engine/costs.js";
import { FA_SIZING_DEFAULTS, FA_SIZING_REFUSALS } from "../src/engine/fa/sizing.js";
import { FA_EXIT_REASONS } from "../src/engine/fa/exit.js";
import { FA_MARGIN_REFUSALS } from "../src/engine/fa/margin.js";
import {
  AUTO_SCHEMA_VERSION, FA_AUTO_BOT_ID, FA_AUTO_INTENTS, FA_AUTO_OUTCOMES, FA_AUTO_PRECEDENCE,
  FA_AUTO_REFUSALS, armAuto, autoTick, createAutoState, defaultAutoParams, ensureAutoState,
  explainAuto, stopAuto,
} from "../src/engine/fa/auto.js";
import { hour } from "./fa-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const H = FA_SIZING_DEFAULTS.horizonH; // 720
const T = 1.7e12; // «сейчас»
const BOOT = T - 3600 * 1000; // процесс поднят час назад
const NOM = 300; // опрос раз в пять минут

// Все коды, которые тик имеет право назвать. Автомат свои заводит сам, остальные приезжают из
// реестров правил КАК ЕСТЬ: копия чужого реестра это вторая реализация.
const KNOWN = new Set([...FA_AUTO_REFUSALS, ...FA_AUTO_OUTCOMES, ...FA_SIZING_REFUSALS, ...FA_EXIT_REASONS]);
const SEEN_CODE = new Set(); // все коды, попавшие в журнал хотя бы раз
const SEEN_WHY = new Set(); // коды, которые хотя бы раз РЕШИЛИ

// ─────────────────────────────────────────────────────────────────────────────
// СТЕНД
// ─────────────────────────────────────────────────────────────────────────────

// Рынок с постоянным потоком. `P` это ВЕСЬ поток окна в долларах.
const flat = ({ P, bShort, bLong = 1e12, hours = H, bases = true, bs = 0, recv = "short" }) =>
  Array.from({ length: hours }, (_, h) => hour(h, { pot: P / (3600 * hours), bShort, bLong, bases, bs, recv }));

// Смешанный рынок: часть часов НАБЛЮДЕНА с базой, часть нет. Ровно то состояние, в котором автомат
// живёт первые тридцать суток накопления.
const partlyBased = ({ P, bShort, bLong = 1e12, withBase, bs = 0 }) =>
  Array.from({ length: H }, (_, h) => hour(h, { pot: P / (3600 * H), bShort, bLong, bs, bases: h < withBase }));

// Конфигурация A держит КОРОТКУЮ ногу GMX, поэтому наша база это `fbase_short`. Живые ворота
// снабжения проходят: база свежая, тождество сошлось, стакан есть.
const market = (token, rows, over = {}) => ({
  token, config: "A", strategy: "two", rows,
  markPx: 100, hlMaxLev: 25,
  live: { bOwnUsd: 1e5, bOtherUsd: 1e12, ...(over.live || {}) },
  impact: null,
  ...over,
});

const rich = (token = "RICH", over = {}) => market(token, flat({ P: 4000, bShort: 1e5 }), over);
const poor = (token = "POOR", over = {}) => market(token, flat({ P: 60, bShort: 1e5 }), over);
const paying = (token = "PAYS", over = {}) => market(token, flat({ P: 4000, bShort: 1e5, recv: "long" }), over);

// Взведённый автомат, у которого прошлый тик был штатным: без бута, без перерыва, без простоя.
const armed = ({ params = null, ...over } = {}) => {
  const st = armAuto(createAutoState({ nowMs: BOOT }), { nowMs: BOOT, params });
  st.lastTickAt = T - NOM * 1000;
  st.uptime = { ticks: 10, firstAt: BOOT, lastAt: st.lastTickAt, maxGapMs: NOM * 1000, gaps: [], nominalSec: NOM };
  return Object.assign(st, over);
};

const held = (over = {}) => ({
  id: "p1", token: "HELD", config: "A", strategy: "two", sizeUsd: 2500,
  entryPx: 100, markPx: 100, hlMaxLev: 25, ...over,
});

function run({ state = armed(), markets = [rich()], ...rest } = {}) {
  const t = autoTick({ now: T, bootAt: BOOT, state, markets, nominalSec: NOM, costs: DEFAULT_COSTS, ...rest });
  for (const r of t.refusals) SEEN_CODE.add(r.code);
  SEEN_WHY.add(t.why);
  // ИНВАРИАНТ КАЖДОГО ТИКА, проверяемый на КАЖДОМ вызове стенда: исход назван и назван известным
  // словом. Пустой исход это дефект, и ловиться он обязан везде, а не в одном специальном тесте.
  assert.ok(FA_AUTO_INTENTS.includes(t.kind), `род намерения вне реестра: ${t.kind}`);
  assert.ok(typeof t.why === "string" && t.why.length > 0, "тик обязан вернуть НАЗВАННЫЙ исход");
  assert.ok(KNOWN.has(t.why), `исход «${t.why}» не принадлежит ни одному реестру`);
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Состояние: форма, взвод, остановка
// ─────────────────────────────────────────────────────────────────────────────

test("форма состояния поднимается АДДИТИВНО: отсутствующее поле это «его не было»", () => {
  const st = ensureAutoState({});
  assert.equal(st.schemaVersion, AUTO_SCHEMA_VERSION);
  assert.equal(st.botId, FA_AUTO_BOT_ID);
  assert.equal(st.on, false, "поднятая пустая форма обязана быть ВЫКЛЮЧЕНА");
  assert.equal(st.mode, "continuous");
  assert.deepEqual(st.uptime.gaps, []);
  // Запись прошлой версии не теряет своих полей и не получает чужих значений.
  const old = ensureAutoState({ on: true, positionId: "p7", armedAt: 5 });
  assert.equal(old.on, true);
  assert.equal(old.positionId, "p7");
  assert.equal(old.params, null, "параметров в старой записи не было, и выдумывать их нельзя");
});

test("взвод ЗАМОРАЖИВАЕТ параметры, остановка ждёт закрытия сделки", () => {
  const st = armAuto(createAutoState({ nowMs: T }), { nowMs: T });
  assert.equal(st.on, true);
  assert.equal(st.armedAt, T);
  assert.deepEqual({ ...st.params }, defaultAutoParams(), "по умолчанию замораживаются значения по умолчанию");
  assert.throws(() => { st.params.capitalUsd = 1; }, "параметры сделки не имеют права меняться под ней");
  // Числа владельца, принятые 2026-08-31.
  assert.equal(st.params.leverage, 1);
  assert.equal(st.params.minRoomFraction, 0.5);
  assert.equal(st.params.capitalUsd, 2500);
  // Пустой слот значит остановиться СРАЗУ; занятый значит довести сделку.
  assert.equal(stopAuto({ ...st, positionId: null }, { nowMs: T }).on, false);
  const busy = stopAuto({ ...st, positionId: "p1" }, { nowMs: T });
  assert.equal(busy.on, true, "бросать открытую сделку нельзя: сторож залога работает только пока автомат тикает");
  assert.equal(busy.stopRequested, true);
  assert.equal(stopAuto({ ...st, positionId: "p1" }, { nowMs: T, immediate: true }).on, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Реестр приоритетов это ДАННЫЕ
// ─────────────────────────────────────────────────────────────────────────────

test("реестр приоритетов покрывает реестр отказов РОВНО, и порядок его содержателен", () => {
  assert.deepEqual([...FA_AUTO_PRECEDENCE].sort(), [...FA_AUTO_REFUSALS].sort(),
    "код без места в приоритете решал бы случайно, место без кода обещало бы небываемое");
  const at = (c) => FA_AUTO_PRECEDENCE.indexOf(c);
  assert.ok(at("off") < at("cadence_wait"), "выключенный автомат не ждёт каданса");
  assert.ok(at("state_stale") < at("boot_warmup"), "после многодневного простоя верны оба, и сильнее говорит срок годности");
  assert.ok(at("margin_thin") < at("cadence_wait"), "сторож залога перебивает каданс: его отказ невосстановим");
  assert.ok(at("margin_unknown") < at("margin_thin"), "не посчитали и посчитали тонко это разные состояния");
  assert.ok(at("state_corrupt") === 0, "состояние, которого нет, старше любого вывода из него");
  // Коды сторожа переиспользуются ССЫЛКОЙ, а не переписаны строками.
  for (const c of FA_MARGIN_REFUSALS) assert.ok(FA_AUTO_REFUSALS.includes(c));
  const src = readFileSync(join(HERE, "..", "src", "engine", "fa", "auto.js"), "utf8");
  assert.ok(src.includes("...FA_MARGIN_REFUSALS"), "реестр сторожа обязан входить ссылкой");
  for (const code of ["below_fund_ratio", "alt_beats_hold", "hold_best", "no_book"]) {
    assert.ok(!src.includes(`"${code}"`), `код «${code}» задублирован строкой вместо ссылки на реестр правила`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Ворота, которые НЕ дают решать. Каждая ветка называет свой код.
// ─────────────────────────────────────────────────────────────────────────────

test("выключенный автомат называет себя и НЕ считает дорогих правил", () => {
  const t = run({ state: ensureAutoState({}) });
  assert.equal(t.kind, "none");
  assert.equal(t.why, "off");
  assert.equal(t.decided, false, "выключенный автомат не имеет права тратить круг вычислений");
  assert.equal(t.universe, null);
});

test("битое состояние старше тумблера: сначала карантин, потом всё остальное", () => {
  const t = run({ state: armed(), corrupt: true });
  assert.equal(t.why, "state_corrupt");
  assert.equal(t.kind, "none");
});

test("бухгалтерия слота: чужая позиция и потерянная своя это РАЗНЫЕ состояния", () => {
  const orphan = run({ state: armed({ positionId: "p404" }), position: null });
  assert.equal(orphan.why, "orphan_position", "автомат помнит сделку, которой в леджере нет");
  const foreign = run({ state: armed(), foreignOpen: true });
  assert.equal(foreign.why, "no_slot", "слот ОДИН, и чужую сделку автомат не ведёт");
  assert.equal(foreign.kind, "none");
});

test("первый тик после старта и перерыв опроса называются ОТДЕЛЬНО, и оба видны сразу", () => {
  // Бут: прошлого тика не было вовсе.
  const boot = run({ state: armed({ lastTickAt: null }) });
  assert.equal(boot.why, "boot_warmup");
  // Перерыв внутри работающей сессии: прошлый тик был, но давно.
  const gap = run({ state: armed({ lastTickAt: T - 40 * 60 * 1000 }) });
  assert.equal(gap.why, "poll_gap");
  assert.equal(gap.events.length, 1, "перерыв это СОБЫТИЕ, а не пропуск");
  assert.equal(gap.events[0].kind, "gap");
  assert.equal(gap.events[0].cause, "unknown", "ни один хинт не покрыл перерыв, и это честный код");
  assert.equal(gap.events[0].lost, 7, "40 минут при опросе раз в пять это семь потерянных слотов");
  assert.equal(gap.state.uptime.gaps.length, 1, "перерыв копится в состоянии, иначе объяснить его будет нечем");
  // Сон машины объясняется хинтом, а не догадкой.
  const slept = run({
    state: armed({ lastTickAt: T - 40 * 60 * 1000 }),
    gapHints: { sleepWindow: { start: T - 39 * 60 * 1000, end: T - 60 * 1000 } },
  });
  assert.equal(slept.events[0].cause, "sleep");
});

test("многодневное молчание перебивает и бут, и перерыв: сильнее говорит срок годности", () => {
  const t = run({ state: armed({ lastTickAt: T - 100 * 3600 * 1000 }) });
  assert.equal(t.why, "state_stale");
  const codes = t.refusals.map((r) => r.code);
  // СПРЯТАННЫЙ КОД ОСТАЁТСЯ ВИДИМЫМ. Ради этого свойства и заведён отдельный реестр приоритетов.
  assert.ok(codes.includes("poll_gap"), "перерыв обязан остаться в журнале, даже когда решает не он");
  assert.ok(codes.includes("state_stale"));
});

test("потолок капитала не назван значит правило размера обязано отказать, а не занять всё", () => {
  const t = run({ state: armed({ params: { capitalUsd: 0 } }) });
  assert.equal(t.why, "capital_missing");
});

test("каданс: без него автомат платил бы круг чаще, чем поднимает", () => {
  const t = run({ state: armed({ lastDecisionAt: T - 3600 * 1000 }) });
  assert.equal(t.why, "cadence_wait");
  assert.equal(t.decided, false);
  // Прошли сутки: решение снова разрешено.
  const ok = run({ state: armed({ lastDecisionAt: T - 25 * 3600 * 1000 }) });
  assert.equal(ok.decided, true);
});

test("запрошенная остановка гасит ВХОД, а не ведение сделки", () => {
  const t = run({ state: armed({ stopRequested: true }) });
  assert.equal(t.why, "stop_pending");
  assert.equal(t.kind, "none");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Ворота снабжения ОДНИ И ТЕ ЖЕ для входа и для удержания
// ─────────────────────────────────────────────────────────────────────────────

test("короткая история отсеивает рынок, а не тик: один рынок без окна это причина не смотреть ЕГО", () => {
  const short = market("SHORT", flat({ P: 4000, bShort: 1e5, hours: 100 }));
  const t = run({ markets: [rich(), short] });
  assert.equal(t.kind, "open", "годный рынок остаётся годным");
  const codes = t.refusals.filter((r) => r.code === "hist_short");
  assert.equal(codes.length, 1);
  assert.equal(codes[0].token, "SHORT", "пер-рыночный отказ обязан называть рынок");
  // А когда годных не осталось ВОВСЕ, это уже причина не решать.
  const none = run({ markets: [short] });
  assert.equal(none.why, "hist_short");
  assert.equal(none.decided, false);
});

test("НАКОПЛЕНИЕ БАЗ ВПЕРЁД: неполное покрытие окна это названный отказ, а не тихий ноль", () => {
  const half = market("HALF", partlyBased({ P: 4000, bShort: 1e5, withBase: H / 2 }));
  const t = run({ markets: [half] });
  assert.equal(t.why, "hist_no_base");
  const r = t.refusals.find((x) => x.code === "hist_no_base");
  assert.equal(r.covered, H / 2, "сколько часов уже накоплено, оператор обязан видеть числом");
  assert.equal(r.hours, H);
  // Порог это ПАРАМЕТР: решение владельца «пока не накопится 720 часов» читается как полное
  // покрытие, а его ослабление обязано быть видимым выбором, а не правкой кода.
  const relaxed = run({ state: armed({ params: { baseCoverageMin: 0.4 } }), markets: [half] });
  assert.notEqual(relaxed.why, "hist_no_base");
});

test("ВОРОТА У ВХОДА И У УДЕРЖАНИЯ ОДНИ И ТЕ ЖЕ: рынок, на котором стоим, тоже обязан их пройти", () => {
  const rows = partlyBased({ P: 4000, bShort: 1e5, withBase: H / 6, bs: 3e-9 });
  const m = market("HELD", rows);
  const t = run({ state: armed({ positionId: "p1" }), position: held(), markets: [m, rich()] });
  assert.equal(t.why, "hist_no_base", "оценивать удержание нечем, и это надо СКАЗАТЬ");
  assert.equal(t.kind, "none");
  assert.equal(t.decided, false, "правило выхода на непрошедших воротах не зовётся вовсе");
});

test("КОНТРОЛЬ: ослабленные ворота выхода стоят круга издержек, и разница видна числом", () => {
  // Тот же рынок и та же минута. Разница только в пороге покрытия.
  const rows = partlyBased({ P: 4000, bShort: 1e5, withBase: H / 6, bs: 3e-9 });
  const m = market("HELD", rows);
  const strict = run({ state: armed({ positionId: "p1" }), position: held(), markets: [m] });
  assert.equal(strict.kind, "none", "строгие ворота держат сделку");

  const weak = run({ state: armed({ positionId: "p1", params: { baseCoverageMin: 0 } }), position: held(), markets: [m] });
  assert.equal(weak.kind, "close", "ослабленные ворота выпускают правило выхода на окно, в которое вход бы не вошёл");
  assert.equal(weak.why, "gross_negative");
  // И это не абстракция: ослабленные ворота видят ОТРИЦАТЕЛЬНОЕ брутто там, где половина часов
  // просто не наблюдалась, то есть платят круг за пропуск в данных.
  assert.ok(weak.exit.holdGrossUsd < 0, "брутто занижено ровно на ненаблюдённые часы");
  // А на ПОЛНОМ покрытии тот же рынок держится: значит закрытие выше вызвано воротами, а не рынком.
  const full = run({ state: armed({ positionId: "p1" }), position: held(), markets: [market("HELD", flat({ P: 4000, bShort: 1e5, bs: 3e-9 }))] });
  assert.equal(full.kind, "none");
  assert.equal(full.why, "hold_best");
});

test("отказ источника называется на КАЖДОМ тике, а решает своим кодом правило", () => {
  const t = run({ sources: { gmxDown: true, hlDown: false } });
  assert.ok(t.refusals.some((r) => r.code === "src_gmx_down"));
  assert.equal(t.why, "src_gmx_down", "код приезжает из реестра правила входа, а не из реестра автомата");
  assert.equal(t.kind, "none");
  const hl = run({ sources: { gmxDown: false, hlDown: true } });
  assert.ok(hl.refusals.some((r) => r.code === "src_hl_down"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Сторож залога: блокирующий, до каданса, до правила выхода
// ─────────────────────────────────────────────────────────────────────────────

test("тонкий запас закрывает сделку НЕ ДОЖИДАЯСЬ каданса", () => {
  const t = run({
    state: armed({ positionId: "p1", lastDecisionAt: T - 1000 }), // каданс явно не подошёл
    position: held({ markPx: 140 }), // цена ушла против короткой ноги GMX
    markets: [market("HELD", flat({ P: 4000, bShort: 1e5 }))],
  });
  assert.equal(t.kind, "close");
  assert.equal(t.why, "margin_thin");
  assert.equal(t.intent.action, "close");
  assert.equal(t.intent.id, "p1");
  assert.ok(t.margin.roomFrac < 0.5);
});

test("НЕИЗВЕСТНЫЙ запас закрытия НЕ требует: отказ снабжения это не вывод правила", () => {
  const t = run({
    state: armed({ positionId: "p1" }),
    position: held({ markPx: null }), // цены нет, считать нечем
    markets: [market("HELD", flat({ P: 4000, bShort: 1e5 }))],
  });
  assert.equal(t.why, "margin_unknown");
  assert.equal(t.kind, "none", "платить круг за икоту источника значит превращать отказ снабжения в решение");
});

test("сторож стоит и на ВХОДЕ: кандидат с тонким запасом не открывается", () => {
  const t = run({ state: armed({ params: { leverage: 2, minRoomFraction: 0.5 } }) });
  assert.equal(t.why, "margin_thin");
  assert.equal(t.kind, "none");
  assert.equal(t.intent, null, "намерения входа при отказе сторожа быть не может");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Намерения: вход, удержание, выход, перекладка
// ─────────────────────────────────────────────────────────────────────────────

test("ВХОД: правило входа зовётся целиком, а автомат берёт ЛУЧШУЮ годную и называет оба размера", () => {
  const t = run({ markets: [rich("A1"), poor("B2")] });
  assert.equal(t.kind, "open");
  assert.equal(t.why, "funded");
  assert.equal(t.intent.token, "A1");
  assert.equal(t.intent.wantUsd, 2500, "заявленный размер это капитал сделки");
  assert.equal(t.intent.gotUsd, 2500, "фактический это то, на чём остановилось правило");
  assert.equal(t.intent.binding, "ticket_cap", "потолок тикета приведён к капиталу сделки");
  assert.equal(t.decided, true);
  assert.equal(t.state.lastDecisionAt, T);
  // Убыточный рынок обязан назвать СВОЙ код, а не выпасть молча.
  assert.ok(t.refusals.some((r) => r.token === "B2" && FA_SIZING_REFUSALS.includes(r.code)));
  // ЗАПИСЬ ВИДИТ КРИВЫЕ ВСЕХ РЫНКОВ: без них ранг занятой позиции задним числом не посчитать.
  assert.ok(t.universe && Array.isArray(t.universe.curves));
  assert.equal(t.window.rows, H, "окно решения пришпилено к тем самым часам");
});

test("ПОТОЛОК ТИКЕТА ПРИВЕДЁН К КАПИТАЛУ, иначе автомат не вошёл бы НИ РАЗУ", () => {
  // Потолок правила $5000, капитал владельца $2500. Годной считается только альтернатива, которая
  // ВЛЕЗАЕТ в капитал, поэтому без приведения все лучшие рынки отсеивались бы по размеру, которым
  // мы всё равно не вошли бы.
  assert.equal(FA_SIZING_DEFAULTS.ticketCapUsd, 5000);
  const t = run();
  assert.equal(t.cfg.ticketCapUsd, 2500);
  assert.ok(t.intent.gotUsd <= 2500);
  // Тот же потолок идёт и в правило выхода: разные потолки на двух ветках это асимметрия ворот.
  const ex = run({ state: armed({ positionId: "p1" }), position: held(), markets: [market("HELD", flat({ P: 4000, bShort: 1e5 }))] });
  assert.equal(ex.cfg.ticketCapUsd, 2500);
});

test("УДЕРЖАНИЕ это НАЗВАННЫЙ исход, а не отсутствие события", () => {
  const t = run({
    state: armed({ positionId: "p1" }), position: held(),
    markets: [market("HELD", flat({ P: 4000, bShort: 1e5 }))],
  });
  assert.equal(t.kind, "none");
  assert.equal(t.why, "hold_best");
  assert.equal(t.decided, true);
  assert.ok(t.exit.holdGrossUsd > 0);
});

test("ВЫХОД В КЭШ: брутто на горизонте отрицательно и альтернатив нет", () => {
  const t = run({
    state: armed({ positionId: "p1" }), position: held(),
    markets: [paying("HELD")],
  });
  assert.equal(t.kind, "close");
  assert.equal(t.why, "gross_negative");
  assert.equal(t.intent.action, "close");
});

test("ПЕРЕКЛАДКА: альтернатива окупает круг и обходит удержание", () => {
  const t = run({
    state: armed({ positionId: "p1" }), position: held(),
    markets: [market("HELD", flat({ P: 60, bShort: 1e5 })), rich("BEST")],
  });
  assert.equal(t.kind, "switch");
  assert.equal(t.why, "alt_beats_hold");
  assert.equal(t.intent.action, "switch");
  assert.equal(t.intent.closeId, "p1");
  assert.equal(t.intent.token, "BEST");
  assert.ok(t.intent.gotUsd > 0);
});

test("АВТОМАТ НЕ ИСПОЛНЯЕТ: тик не трогает ни леджера, ни поданного состояния", () => {
  const st = armed();
  const before = JSON.stringify(st);
  const t = run({ state: st });
  assert.equal(JSON.stringify(st), before, "поданное состояние обязано остаться прежним: исполняет главный процесс");
  assert.notEqual(t.state, st, "тик возвращает НОВОЕ состояние");
  assert.equal(t.state.lastTickAt, T);
  // Ни сети, ни файлов, ни собственных часов в модуле нет. Комментарии из счёта убираются: шапка
  // обязана НАЗЫВАТЬ запрет, и запрещать себе его называть было бы нелепо.
  const code = readFileSync(join(HERE, "..", "src", "engine", "fa", "auto.js"), "utf8")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  for (const forbidden of ["Date.now", "node:fs", "readFileSync", "fetch("]) {
    assert.ok(!code.includes(forbidden), `чистый редьюсер не имеет права на ${forbidden}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Достижимость реестра в ОБЕ стороны и три контроля
// ─────────────────────────────────────────────────────────────────────────────

test("каждый код автомата ДОСТИЖИМ и каждый хоть раз РЕШАЕТ; достижимого вне реестров нет", () => {
  const missing = FA_AUTO_REFUSALS.filter((c) => !SEEN_CODE.has(c));
  assert.deepEqual(missing, [], `коды реестра, которых не получил ни один тест: ${missing.join(", ")}`);
  // Реестр приоритетов обещает, что каждый его код МОЖЕТ решить. Обещание проверяется.
  const neverDecided = FA_AUTO_PRECEDENCE.filter((c) => !SEEN_WHY.has(c));
  assert.deepEqual(neverDecided, [], `коды приоритета, которые ни разу не решили: ${neverDecided.join(", ")}`);
  const extra = [...SEEN_CODE].filter((c) => !KNOWN.has(c));
  assert.deepEqual(extra, [], `коды вне всех реестров: ${extra.join(", ")}`);
  assert.deepEqual([...FA_AUTO_INTENTS], ["none", "open", "close", "switch"]);
  assert.deepEqual([...FA_AUTO_OUTCOMES], ["funded"]);
});

test("КОНТРОЛЬ: тумблер, не переживший рестарт, ловится этой проверкой", () => {
  const st = armAuto(createAutoState({ nowMs: T }), { nowMs: T });
  st.positionId = "p1";
  // Круг через диск: состояние сериализуется целиком и поднимается аддитивно.
  const revived = ensureAutoState(JSON.parse(JSON.stringify(st)));
  assert.equal(revived.on, true, "тумблер обязан пережить рестарт");
  assert.equal(revived.positionId, "p1", "и слот вместе с ним");
  assert.deepEqual(revived.params, { ...st.params }, "и замороженные параметры сделки");
  // А вот наивный подъём «создать заново, раз файла как будто нет» даёт ВЫКЛЮЧЕННЫЙ автомат, и
  // проверка выше это ловит. Без контроля она проверяла бы собственную удачу.
  assert.throws(() => assert.equal(createAutoState({ nowMs: T }).on, true));
  assert.throws(() => assert.equal(ensureAutoState({ ...JSON.parse(JSON.stringify(st)), on: undefined }).on, true));
});

test("КОНТРОЛЬ: молчаливый пропуск ловится, потому что исход обязан быть НАЗВАН известным словом", () => {
  const named = (t) => {
    assert.ok(typeof t.why === "string" && t.why.length > 0, "пустой исход это дефект");
    assert.ok(KNOWN.has(t.why), `исход «${t.why}» не принадлежит ни одному реестру`);
  };
  // Проверка держится на любом законном тике.
  named(run());
  named(run({ state: ensureAutoState({}) }));
  // И ловит оба способа промолчать: без исхода и с выдуманным исходом.
  const t = run();
  assert.throws(() => named({ ...t, why: null }));
  assert.throws(() => named({ ...t, why: "" }));
  assert.throws(() => named({ ...t, why: "всё_хорошо" }));
});

test("журнал объясняет тик одной строкой и НАЗЫВАЕТ спрятанные коды", () => {
  const cases = [
    run(),
    run({ state: ensureAutoState({}) }),
    run({ state: armed({ positionId: "p1" }), position: held(), markets: [market("HELD", flat({ P: 4000, bShort: 1e5 }))] }),
    run({ state: armed({ positionId: "p1" }), position: held(), markets: [paying("HELD")] }),
    run({ state: armed({ positionId: "p1" }), position: held(), markets: [market("HELD", flat({ P: 60, bShort: 1e5 })), rich("BEST")] }),
  ];
  for (const t of cases) {
    const line = explainAuto(t);
    assert.ok(line.length > 10, `пустая строка: ${line}`);
    assert.ok(!line.includes("undefined") && !line.includes("NaN"), `дыра в строке: ${line}`);
  }
  assert.equal(explainAuto(null), "тика нет");
  // Спрятанный код виден оператору именно в строке, иначе реестр приоритетов прятал бы данные.
  const stale = run({ state: armed({ lastTickAt: T - 100 * 3600 * 1000 }) });
  assert.ok(explainAuto(stale).includes("poll_gap"), "перекрытый код обязан быть назван");
});

test("замыкание импортов автомата НЕ пересекается с ботом 2", () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*import[^"']*["'](\.[^"']+)["']/gm)) walk(join(dirname(file), m[1]));
  };
  walk(join(HERE, "..", "src", "engine", "fa", "auto.js"));
  const btc = [...seen].filter((f) => f.includes("btcopt"));
  assert.deepEqual(btc, [], `автомат тянет модули бота 2: ${btc.join(", ")}`);
  assert.ok(seen.size >= 8, "замыкание обязано быть непустым, иначе тест проверяет опечатку в пути");
  // Зависимость строго в одну сторону: правила не имеют права знать об автомате.
  for (const f of ["sizing.js", "exit.js", "margin.js", "record.js", "bases.js"]) {
    const src = readFileSync(join(HERE, "..", "src", "engine", "fa", f), "utf8");
    assert.ok(!/from\s+["'][^"']*auto\.js["']/.test(src), `${f} не имеет права импортировать auto.js`);
  }
});
