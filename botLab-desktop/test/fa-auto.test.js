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
import { FA_SIZING_DEFAULTS, FA_SIZING_REFUSALS, faSizingPreset } from "../src/engine/fa/sizing.js";
import { FA_EXIT_REASONS } from "../src/engine/fa/exit.js";
import { FA_MARGIN_REFUSALS } from "../src/engine/fa/margin.js";
import { FA_DRAWDOWN_REFUSALS } from "../src/engine/fa/drawdown.js";
import {
  AUTO_SCHEMA_VERSION, FA_AUTO_BOT_ID, FA_AUTO_INTENTS, FA_AUTO_OUTCOMES, FA_AUTO_PRECEDENCE,
  FA_AUTO_REFUSALS, armAuto, autoHorizonH, autoTick, autoViewWindowDays, autoWindowH, createAutoState,
  defaultAutoParams, ensureAutoState, explainAuto, legSpreadApr, stopAuto,
} from "../src/engine/fa/auto.js";
import { annualizeRow } from "../src/engine/math.js";
import { bestAlternative } from "../src/engine/fa/exit.js";
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

test("метка ленты и начало перерыва ПЕРЕЖИВАЮТ перезапуск, иначе дыру нечем объяснить", () => {
  const st = ensureAutoState({});
  assert.equal(st.lastSnapAt, null, "ленты ещё нет");
  assert.equal(st.offSince, null);
  // Перерыв меряется по ленте, а не по таймеру сессии: таймер рестарт обнуляет, и тогда причина
  // `app-down` недостижима, то есть реестр причин обещает то, чего писатель выдать не может.
  const kept = ensureAutoState({ lastSnapAt: 111, offSince: 222 });
  assert.equal(kept.lastSnapAt, 111);
  assert.equal(kept.offSince, 222);
  // Останов открывает дыру. `stoppedAt` для этого не годится: взвод его обнуляет, а объяснять дыру
  // приходится уже ПОСЛЕ взвода, на первом же тике.
  const armed = armAuto(createAutoState({ nowMs: T }), { nowMs: T });
  const off = stopAuto({ ...armed, positionId: null }, { nowMs: T + 60000 });
  assert.equal(off.offSince, T + 60000);
  assert.equal(armAuto({ ...off }, { nowMs: T + 120000 }).offSince, T + 60000,
    "взвод НЕ стирает начало перерыва: иначе объяснять будет нечем");
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
  assert.ok(at("margin_thin") < at("drawdown_stop"), "ликвидация ноги невосстановима, просадка это уже отданные деньги");
  assert.ok(at("drawdown_stop") < at("hist_no_base"), "стоп считает по леджеру сделки и не нуждается в базах");
  assert.ok(at("drawdown_stop") < at("cadence_wait"), "стоп не ждёт каданса");
  assert.ok(at("state_corrupt") === 0, "состояние, которого нет, старше любого вывода из него");
  // Коды сторожа переиспользуются ССЫЛКОЙ, а не переписаны строками.
  for (const c of FA_MARGIN_REFUSALS) assert.ok(FA_AUTO_REFUSALS.includes(c));
  for (const c of FA_DRAWDOWN_REFUSALS) assert.ok(FA_AUTO_REFUSALS.includes(c));
  const src = readFileSync(join(HERE, "..", "src", "engine", "fa", "auto.js"), "utf8");
  assert.ok(src.includes("...FA_MARGIN_REFUSALS"), "реестр сторожа обязан входить ссылкой");
  assert.ok(src.includes("...FA_DRAWDOWN_REFUSALS"), "реестр сторожа просадки обязан входить ссылкой");
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
// 5a. Сторож просадки: по леджеру сделки, до каданса и до правила выхода (замер З6, drawdown.js)
// ─────────────────────────────────────────────────────────────────────────────

// Сделка, отдавшая от пика два круга: круг $9, пик $25, накоплено $5, просадка $20 при пороге $18.
const bleeding = (over = {}) => held({ cumUsd: 5, peakUsd: 25, roundTripUsd: 9, ...over });
const bleedMarkets = () => [market("HELD", flat({ P: 4000, bShort: 1e5 }))];

test("стоп по просадке закрывает сделку НЕ ДОЖИДАЯСЬ каданса и сдвигает метку решения на сейчас", () => {
  const t = run({
    state: armed({ positionId: "p1", lastDecisionAt: T - 1000, lastDecisionCtx: { token: "HELD", negHours: 0, potUsdPerSec: 1, roomFrac: 0.9 } }),
    position: bleeding(),
    markets: bleedMarkets(),
  });
  assert.equal(t.kind, "close");
  assert.equal(t.why, "drawdown_stop");
  assert.equal(t.intent.action, "close");
  assert.equal(t.intent.id, "p1");
  assert.equal(t.drawdown.code, "drawdown_stop");
  assert.equal(t.drawdown.drawdownUsd, 20);
  assert.equal(t.drawdown.thresholdUsd, 18);
  assert.equal(t.state.lastDecisionAt, T, "после стопа следующее решение через каданс, как в замере З6");
  assert.equal(t.state.lastDecisionCtx, null, "сделки не будет: событиям не от чего меряться");
  assert.equal(t.decided, false, "стоп это сторож, а не решение правила: строки решения нет");
  const r = t.refusals.find((x) => x.code === "drawdown_stop");
  assert.equal(r.where, "position");
  assert.equal(r.rounds, 2);
  assert.match(explainAuto(t), /ВЫХОД HELD/);
});

test("просадка НИЖЕ порога стоп не зовёт, а порог включительный", () => {
  const below = run({ state: armed({ positionId: "p1", lastDecisionAt: T - 1000 }), position: bleeding({ cumUsd: 7.5 }), markets: bleedMarkets() });
  assert.equal(below.why, "cadence_wait");
  assert.equal(below.kind, "none");
  assert.equal(below.drawdown.known, true);
  assert.equal(below.drawdown.ok, true);
  assert.equal(below.drawdown.drawdownUsd, 17.5);
  const edge = run({ state: armed({ positionId: "p1", lastDecisionAt: T - 1000 }), position: bleeding({ cumUsd: 7 }), markets: bleedMarkets() });
  assert.equal(edge.why, "drawdown_stop");
});

test("параметр ноль ВЫКЛЮЧАЕТ стоп, а неизвестные числа леджера его не зовут", () => {
  const off = run({ state: armed({ positionId: "p1", lastDecisionAt: T - 1000, params: { drawdownStopRounds: 0 } }), position: bleeding({ cumUsd: -100 }), markets: bleedMarkets() });
  assert.equal(off.why, "cadence_wait");
  assert.equal(off.drawdown.enabled, false);
  // Позиция без чисел леджера (старая форма) не даёт кода: это отказ снабжения, а не просадка.
  const blind = run({ state: armed({ positionId: "p1", lastDecisionAt: T - 1000 }), position: held(), markets: bleedMarkets() });
  assert.equal(blind.why, "cadence_wait");
  assert.equal(blind.drawdown.enabled, true);
  assert.equal(blind.drawdown.known, false);
  assert.ok(!blind.refusals.some((x) => x.code === "drawdown_stop"));
  // Без открытой сделки вердикта нет вовсе.
  assert.equal(run({}).drawdown, null);
});

test("сторож залога старше стопа, стоп старше ворот снабжения удерживаемого рынка", () => {
  const thin = run({ state: armed({ positionId: "p1" }), position: bleeding({ markPx: 140 }), markets: bleedMarkets() });
  assert.equal(thin.why, "margin_thin", "ликвидация ноги невосстановима, просадка это уже отданные деньги");
  assert.equal(thin.kind, "close");
  assert.ok(thin.refusals.some((x) => x.code === "drawdown_stop"), "код стопа остаётся в журнале, хоть решил не он");
  // Дыра в базах удерживаемого рынка блокирует правило выхода, но не стоп: он считает по леджеру.
  const gated = run({ state: armed({ positionId: "p1" }), position: bleeding(), markets: [market("HELD", partlyBased({ P: 4000, bShort: 1e5, withBase: 100 }))] });
  assert.equal(gated.why, "drawdown_stop");
  assert.equal(gated.kind, "close");
  assert.ok(gated.refusals.some((x) => x.code === "hist_no_base"), "отказ ворот остаётся в журнале");
});

test("умолчание параметров несёт стоп в два круга, и взвод его замораживает", () => {
  assert.equal(defaultAutoParams().drawdownStopRounds, 2);
  const st = armAuto(createAutoState({ nowMs: T }), { nowMs: T });
  assert.equal(st.params.drawdownStopRounds, 2);
  // Состояние, взведённое ДО появления параметра, получает умолчание при слиянии: живой автомат на
  // mb12 взведён 01.09 и переоснащается без перевзвода.
  const oldState = armed({ positionId: "p1", lastDecisionAt: T - 1000 });
  oldState.params = Object.freeze({ ...defaultAutoParams(), drawdownStopRounds: undefined });
  const t = run({ state: oldState, position: bleeding(), markets: bleedMarkets() });
  assert.equal(t.why, "drawdown_stop");
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
  // Концы строк приводятся к LF: Windows-чекаут с autocrlf даёт \r\n, и без этого хвост
  // комментария с \r не отрезался бы (поймано Windows-прогоном релиза 0.3.2).
  const code = readFileSync(join(HERE, "..", "src", "engine", "fa", "auto.js"), "utf8")
    .replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
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

// ─────────────────────────────────────────────────────────────────────────────
// СВОДКА ПОСЛЕДНЕЙ ОЦЕНКИ ПО РЫНКАМ
//
// Заведена ради интерфейса: пер-рыночные отказы уезжают наружу одним решающим кодом, поэтому без
// этой сводки экран не мог ответить на вопрос «что бот увидел по КАЖДОМУ рынку». Правило показа
// требует, чтобы ответ приходил из движка готовым, а не выводился в отрисовщике второй раз.
// ─────────────────────────────────────────────────────────────────────────────

test("сводка оценки: строка на КАЖДЫЙ рынок вселенной, включая не дошедшие до правила размера", () => {
  // Три рынка: доходный, убыточный и такой, у которого истории меньше горизонта. Последний до
  // правила размера не доходит вовсе, и его строка обязана существовать со своим кодом.
  const short = market("SHORTHIST", flat({ P: 4000, bShort: 1e5, hours: 100 }));
  const t = run({ markets: [rich("RICH"), poor("POOR"), short] });
  assert.ok(Array.isArray(t.evalMarkets), "сводка обязана быть массивом на решённом тике");
  assert.deepEqual(t.evalMarkets.map((m) => m.token), ["RICH", "POOR", "SHORTHIST"],
    "порядок и состав строк повторяют вселенную, а не список кривых");
  const byToken = Object.fromEntries(t.evalMarkets.map((m) => [m.token, m]));
  assert.equal(byToken.SHORTHIST.refusal, "hist_short", "рынок, отсеянный воротами, назван кодом ворот");
  assert.equal(byToken.SHORTHIST.funded, false);
  assert.equal(byToken.SHORTHIST.coverage, null, "покрытия у него не измеряли - прочерк, а не ноль");
  assert.equal(byToken.SHORTHIST.rank, null);
  assert.ok(byToken.RICH.funded, "доходный рынок профинансирован");
  assert.equal(byToken.RICH.refusal, null);
  assert.ok(byToken.RICH.coverage > 0, "у прошедшего ворота рынка покрытие измерено");
  assert.ok(byToken.POOR.refusal && byToken.POOR.funded === false, "убыточный назван кодом ПРАВИЛА, а не ворот");
});

/* ══ ОТКАЗ СНАБЖЕНИЯ НЕ ИМЕЕТ ПРАВА ВЫГЛЯДЕТЬ КАК ВЫВОД ПРАВИЛА ═════════════════════════════════
   Здесь стояла подстановка `gate.code ?? (cur ? cur.refusal : "hist_short")`. У рынка, ПРОШЕДШЕГО
   ворота, `gate.code` равен null, `??` проваливался вправо, и когда правило входа выходило ранним
   возвратом без кривых вовсе, КАЖДАЯ строка получала «истории меньше горизонта» рядом с покрытием
   100%. Это худший класс дефекта проекта: правдоподобное неверное объяснение, живущее сутки, - тик
   при этом всё равно ставит `lastDecisionAt`.

   ПРОВЕРКА УМЕЕТ ПАДАТЬ: вернуть подстановку - и `hist_short` появится там, где истории 720 часов.
   ══════════════════════════════════════════════════════════════════════════════════════════ */
test("сводка оценки: отказ ИСТОЧНИКА называется своим кодом, а не занимает чужой", () => {
  for (const [flag, code] of [["gmxDown", "src_gmx_down"], ["hlDown", "src_hl_down"]]) {
    const t = run({ markets: [rich("RICH"), poor("POOR")], sources: { [flag]: true } });
    assert.equal(t.why, code, "решающий код тика это отказ снабжения");
    assert.equal(t.evalMarkets.length, 2);
    for (const m of t.evalMarkets) {
      assert.equal(m.refusal, code, `${m.token}: строка обязана назвать ТОТ отказ, который случился`);
      assert.equal(m.refusalFrom, "slice", `${m.token}: код накрыл весь срез, а не этот рынок`);
      assert.equal(m.funded, false);
      assert.notEqual(m.refusal, "hist_short",
        `${m.token}: истории у него 720 часов, и говорить обратное значит объяснять неверно`);
      assert.equal(m.coverage, 1, "ворота рынок ПРОШЁЛ, и покрытие у него измерено");
    }
  }
});

test("сводка оценки: происхождение кода различает суждение о рынке и отказ всего среза", () => {
  const short = market("SHORTHIST", flat({ P: 4000, bShort: 1e5, hours: 100 }));
  const t = run({ markets: [rich("RICH"), poor("POOR"), short] });
  const by = Object.fromEntries(t.evalMarkets.map((m) => [m.token, m]));
  assert.equal(by.RICH.refusalFrom, null, "профинансированный рынок отказа не имеет вовсе");
  assert.equal(by.POOR.refusalFrom, "curve", "убыточный рынок это суждение ПРАВИЛА о нём");
  assert.equal(by.SHORTHIST.refusalFrom, "gate", "короткая история это суждение ВОРОТ о нём");
  // Ворота отсеяли рынок, а срез при этом жив: чужого кода в его строке быть не может.
  assert.equal(by.SHORTHIST.refusal, "hist_short");
});

test("сводка оценки: на удержании отказ правила выхода тоже не подменяется чужим кодом", () => {
  // Правило выхода откладывает решение целиком (`defer`) и кривых не возвращает НИ ОДНОЙ.
  const t = run({
    markets: [market("HELD", flat({ P: 4000, bShort: 1e5 })), rich("RICH")],
    position: held(), sources: { gmxDown: true },
  });
  assert.equal(t.why, "src_gmx_down");
  for (const m of t.evalMarkets) {
    assert.equal(m.refusal, "src_gmx_down", `${m.token}: причина названа кодом САМОГО правила`);
    assert.equal(m.refusalFrom, "slice");
  }
});

test("сводка оценки: рынок без токена не забирает исход ворот у соседа", () => {
  // Ворота хранились Map-ой по токену, и рынок без токена в неё не попадал: его строка молча брала
  // код соседа или выдуманный `hist_short`. Теперь исход ворот идёт ПО МЕСТУ в списке.
  const nameless = { ...rich("RICH"), token: null, rows: flat({ P: 4000, bShort: 1e5, hours: 100 }) };
  const t = run({ markets: [rich("RICH"), nameless] });
  const row = t.evalMarkets[1];
  assert.equal(row.token, null);
  assert.equal(row.refusal, "hist_short", "у него истории 100 часов, и это его собственный отказ");
  assert.equal(row.refusalFrom, "gate");
  assert.equal(t.evalMarkets[0].refusalFrom, null, "у соседа исход свой и не тронут");
});

test("сводка оценки: ранг ставит тот же предикат, что и выбор рынка входа", () => {
  const t = run({ markets: [poor("POOR"), rich("RICH"), rich("RICH2")] });
  const best = bestAlternative(t.universe.curves, t.params.capitalUsd);
  const rank1 = t.evalMarkets.find((m) => m.rank === 1);
  assert.ok(best && rank1, "и выбор, и ранг обязаны существовать");
  assert.equal(rank1.token, best.token, "ранг 1 обязан совпасть с bestAlternative - иначе выбор и показ разъедутся");
  // Ранги плотные и без дыр среди годных; непрофинансированный ранга не получает.
  const ranks = t.evalMarkets.filter((m) => m.rank != null).map((m) => m.rank).sort((a, b) => a - b);
  assert.deepEqual(ranks, ranks.map((_, i) => i + 1));
  for (const m of t.evalMarkets) if (!m.funded) assert.equal(m.rank, null, `${m.token}: отказ не может иметь ранга`);
});

test("сводка оценки: рынок, не влезающий в капитал, профинансирован, но ранга не имеет", () => {
  // Тот же предикат, что у `bestAlternative`: годная кривая обязана ВЛЕЗАТЬ в доступный капитал.
  const t = run({ markets: [rich("RICH")], state: armed({ params: { ...defaultAutoParams(), capitalUsd: 1 } }) });
  for (const m of t.evalMarkets) assert.equal(m.rank, null, "при потолке в доллар ранга нет ни у кого");
});

test("сводка оценки: между решениями её НЕТ, и пустотой она не притворяется", () => {
  // Каданс не подошёл: вселенная не пересчитывалась, и выдавать прошлую сводку за новую нельзя.
  const st = armed();
  st.lastDecisionAt = T - 1000; // решение только что было
  const t = run({ state: st });
  assert.equal(t.why, "cadence_wait");
  assert.equal(t.decided, false);
  assert.equal(t.evalMarkets, null, "на тике без решения сводки нет вовсе");
});

test("сводка оценки: ставка ног сведена ДВИЖКОМ и совпадает с таблицей годовых", () => {
  const rates = { f_long: -2e-9, f_short: 3e-9, b_long: 4e-10, b_short: 5e-10, hl_rate: 1e-6 };
  const a = annualizeRow(rates);
  assert.equal(legSpreadApr(rates, "two", "A"), a.net_A, "конфигурация A это короткая нога GMX");
  assert.equal(legSpreadApr(rates, "two", "B"), a.net_B, "конфигурация B это длинная нога GMX");
  assert.equal(legSpreadApr(rates, "one"), a.gmx_short_recv - a.gmx_borrow_short, "у однуногой ноги HL нет");
  // Неполный срез это ОТСУТСТВИЕ ставки, а не ноль: ноль читался бы как измеренная нулевая ставка.
  assert.equal(legSpreadApr({ f_short: 3e-9, b_short: 5e-10 }, "two", "A"), null);
  assert.equal(legSpreadApr(null, "two", "A"), null);
  // И то же число доезжает в строке сводки.
  const t = run({ markets: [rich("RICH", { rates })] });
  assert.equal(t.evalMarkets[0].legApr, a.net_A, "строка сводки несёт ту же величину, что и таблица");
});

// ─────────────────────────────────────────────────────────────────────────────
// ГОРИЗОНТ ПРАВИЛА И ОКНО ПАНЕЛЕЙ: ОДНО ЧИСЛО, А НЕ ПЯТЬ РУКОПИСНЫХ КОПИЙ
//
// 720 часов (и их пересчёт в 30 суток) были вписаны руками в главном процессе, в отрисовщике, в
// оракуле и по два раза в каждом из двух словарей. Ни одна копия не выводилась из движка, и ни один
// тест их не сверял: смена горизонта правила развела бы их МОЛЧА, а шапка зоны продолжала бы
// обещать прежнее окно. Тест держит обе стороны - число выводится отсюда, и снаружи его копий нет.
// ─────────────────────────────────────────────────────────────────────────────

test("ворота называют порог в часах и дату его достижения тем же счётом, что и отказ", () => {
  // Интерфейс спрашивает «сколько ещё ждать», и ответ обязан прийти из ворот готовым: окно,
  // покрытие и порог живут в тике, второй счёт снаружи разошёлся бы с ними на границе.
  const need = 684; // 95% от 720: наименьшее k, при котором k / 720 >= 0.95
  const based = (withBase) => market("PART", partlyBased({ P: 4000, bShort: 1e5, withBase }));
  const t = run({ markets: [based(100)] });
  assert.equal(t.why, "hist_no_base");
  assert.equal(t.gate.covBestH, 100, "покрытых часов у лучшего рынка");
  assert.equal(t.gate.covNeedH, need, "порог в часах");
  assert.equal(t.gate.covMissingH, need - 100, "недостающих часов");
  assert.equal(t.gate.covEtaMs, T + (need - 100) * 3600 * 1000, "дата: час наблюдения даёт один покрытый час");
  // Порог в часах согласован с САМИМ предикатом ворот: need часов проходят, need - 1 нет.
  const pass = run({ markets: [based(need)] });
  assert.notEqual(pass.why, "hist_no_base", "ровно порог проходит ворота");
  assert.equal(pass.gate.covMissingH, 0);
  assert.equal(pass.gate.covEtaMs, null, "полное покрытие: ждать нечего, даты нет");
  const fail = run({ markets: [based(need - 1)] });
  assert.equal(fail.why, "hist_no_base", "на час меньше порога ворота не проходят");
  assert.equal(fail.gate.covMissingH, 1);
  assert.equal(fail.gate.covEtaMs, T + 3600 * 1000);
  // Все рынки короче горизонта: покрытия нет ни у кого, и дата не выдумывается.
  const short = run({ markets: [market("S", flat({ P: 4000, bShort: 1e5, hours: H - 1 }))] });
  assert.equal(short.gate.covBestH, null);
  assert.equal(short.gate.covMissingH, null);
  assert.equal(short.gate.covEtaMs, null);
  assert.equal(short.gate.covNeedH, need, "порог назван и без рынков: он свойство параметров, а не вселенной");
});

test("ворота делят покрытие лучшего рынка по происхождению и не называют долитое наблюдённым", () => {
  // РЕШЕНИЕ ВЛАДЕЛЬЦА 2026-09-02: часы окна без живого наблюдения доливаются историей индексатора
  // (`fa/bases.js`). Ворота смотрят на СУММУ покрытия, а разбивка едет интерфейсу и в запись
  // решения готовой, потому что считать её снаружи запрещено, а называть долитое наблюдённым нельзя.
  const need = 684;
  const marked = (withBase, src) => partlyBased({ P: 4000, bShort: 1e5, withBase })
    .map((r, h) => (h < withBase ? { ...r, fbase_src: src(h) } : r));
  // 300 часов живьём, 400 долито, 5 с базой без метки: сумма 705 проходит порог.
  const t = run({ markets: [market("MIX", marked(705, (h) => (h < 300 ? "live" : h < 700 ? "indexer" : null)))] });
  assert.notEqual(t.why, "hist_no_base", "ворота смотрят на сумму: долитые часы это покрытие");
  assert.equal(t.gate.covBestH, 705);
  assert.equal(t.gate.covLiveH, 300);
  assert.equal(t.gate.covIndexerH, 400);
  assert.equal(t.gate.covUnknownH, 5, "база без метки идёт в «неизвестно», а не приписывается живому");
  assert.equal(t.gate.covLiveH + t.gate.covIndexerH + t.gate.covUnknownH, t.gate.covBestH);
  assert.equal(t.gate.covMissingH, 0);
  assert.equal(t.gate.covEtaMs, null, "порог взят: даты нет");
  // Ниже порога: запись отказа несёт ту же разбивку, чтобы интерфейс не считал её сам.
  const f = run({ markets: [market("LOW", marked(100, (h) => (h < 30 ? "live" : "indexer")))] });
  assert.equal(f.why, "hist_no_base");
  const n = f.refusals.find((r) => r.code === "hist_no_base" && r.token === "LOW");
  assert.equal(n.covered, 100);
  assert.equal(n.live, 30);
  assert.equal(n.indexer, 70);
  assert.equal(n.unknown, 0);
  assert.equal(f.gate.covLiveH, 30);
  assert.equal(f.gate.covIndexerH, 70);
  assert.equal(f.gate.covMissingH, need - 100, "порог и недостача считаются от суммы");
  // Все рынки короче горизонта: разбивки нет, как и покрытия, и нулём она не притворяется.
  const short = run({ markets: [market("S", flat({ P: 4000, bShort: 1e5, hours: H - 1 }))] });
  assert.equal(short.gate.covLiveH, null);
  assert.equal(short.gate.covIndexerH, null);
  assert.equal(short.gate.covUnknownH, null);
});

test("горизонт и окно панелей выводятся из движка тем же выражением, что и cfg тика", () => {
  assert.equal(autoHorizonH(), H, "по умолчанию горизонт это горизонт правила размера");
  assert.equal(autoViewWindowDays(), H / 24, "окно панелей это горизонт в сутках, и ничего больше");
  // Замороженный пресет взвода перебивает умолчание: автомат работает ТЕМ горизонтом, который
  // заморожен, и панели обязаны показывать те же часы.
  const st = armAuto(createAutoState({ nowMs: T }), { nowMs: T, params: { presetId: "fa-uniform-v1" } });
  assert.equal(autoHorizonH(st), (faSizingPreset("fa-uniform-v1") || {}).horizonH);
  // Тик считает свой горизонт САМ, и два числа обязаны совпасть - иначе панели показали бы часы,
  // которых решение не видело.
  const t = run({ state: armed() });
  assert.equal(t.cfg.horizonH, autoHorizonH(armed()), "горизонт тика и горизонт панелей это одно число");
  assert.equal(t.gate.horizonH, autoViewWindowDays(armed()) * 24);
  // Неизвестный пресет не выдумывает горизонта: падать назад можно только на умолчание правила.
  const bad = armAuto(createAutoState({ nowMs: T }), { nowMs: T, params: { presetId: "нет-такого" } });
  assert.equal(autoHorizonH(bad), FA_SIZING_DEFAULTS.horizonH);
});

test("окна и горизонта нет рукописной копией ни в главном процессе, ни в отрисовщике, ни в оракуле", () => {
  const read = (...p) => readFileSync(join(HERE, "..", ...p), "utf8");
  const main = read("src", "main", "main.js");
  assert.match(main, /faauto\.autoViewWindowDays\(/, "окно панелей главный процесс обязан брать у движка");
  assert.ok(!/FA_VIEW_WINDOW_DAYS\s*=\s*\d/.test(main), "рукописного окна в главном процессе быть не должно");
  const oracle = read("scripts", "selector-oracle.mjs");
  assert.match(oracle, /VIEW_WINDOW\s*=\s*autoViewWindowDays\(\)/, "оракул обязан брать окно у движка");
  const html = read("src", "renderer", "index.html");
  const stateBlock = html.match(/^const state = \{[\s\S]*?\n\};/m);
  assert.ok(stateBlock, "состояние вкладки бота 1 в отрисовщике не найдено - сломался разбор, а не код");
  assert.match(stateBlock[0], /win:\s*null/, "окно в отрисовщике обязано приезжать из движка, а не стоять числом");
  assert.match(stateBlock[0], /horizonH:\s*null/, "горизонт туда же и на тех же основаниях");
  // Подписи, в которых число стояло литералом в обеих локалях, стали шаблонами.
  for (const loc of ["ru", "en"]) {
    const dict = read("src", "renderer", "locales", `${loc}.js`);
    const lines = dict.split("\n").filter((l) => /'(fa\.za\.hint|fa\.foot\.d4b?|help\.spread\.b|help\.fa-auto\.b)':/.test(l));
    assert.equal(lines.length, 5, `${loc}: пять подписей, в которых число окна стояло литералом`);
    for (const l of lines) {
      assert.ok(/\{faWinD\}|\{faHorizonH\}/.test(l), `${loc}: подпись обязана быть шаблоном: ${l.slice(0, 60)}`);
      assert.ok(!new RegExp(`\\b${H}\\b`).test(l) && !new RegExp(`\\b${H / 24}[\\s-]`).test(l),
        `${loc}: числа окна в подписи быть не должно: ${l.slice(0, 60)}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// СОБЫТИЯ ВНЕОЧЕРЕДНОГО РЕШЕНИЯ И ДВА ЧИСЛА ОКНА (решение владельца 2026-09-02)
//
// Каданс 24 ч остаётся, а между кадансами правило зовётся по событию (`events.js`). Событие двигает
// только момент: решает то же правило с той же полосой гистерезиса, и на неизменившихся данных
// перекладки от него нет. События меряются от снимка прошлого решения, поэтому одно условие не
// зовёт правило тик за тиком. Окно оценки назад и горизонт вперёд разнесены, ворота режут по окну.
// ─────────────────────────────────────────────────────────────────────────────

// Удерживаемый рынок с постоянным потоком, у которого ПОСЛЕДНИЕ `tail` часов платим мы.
const heldRows = (tail = 0) => Array.from({ length: H }, (_, h) =>
  hour(h, { pot: 4000 / (3600 * H), bShort: 1e5, bLong: 1e12, recv: h >= H - tail ? "long" : "short" }));
const heldMarket = (rows, over = {}) => market("HELD", rows, over);
const ctxAt = (over = {}) => ({ token: "HELD", negHours: 0, potUsdPerSec: null, roomFrac: null, ...over });
// Взведённый автомат, решивший ТОЛЬКО ЧТО: по кадансу следующий тик решать не имеет права.
const decidedJustNow = (ctx) => armed({ positionId: "p1", lastDecisionAt: T - 1000, lastDecisionCtx: ctx });

test("повод решения: каданс на плановом тике, null без решения; закрытие по сторожу это отказ, а не повод", () => {
  const plan = run({ markets: [rich()] });
  assert.equal(plan.decided, true);
  assert.equal(plan.trigger, "cadence");
  const wait = run({ state: armed({ lastDecisionAt: T - 1000 }) });
  assert.equal(wait.why, "cadence_wait");
  assert.equal(wait.trigger, null, "без решения повода нет");
  assert.deepEqual(wait.decisionEvents, []);
  const thin = run({ state: decidedJustNow(ctxAt()), markets: [heldMarket(heldRows())], position: held({ token: "HELD", markPx: 160 }) });
  assert.equal(thin.kind, "close");
  assert.equal(thin.why, "margin_thin");
  assert.equal(thin.decided, false, "правила не звались: сторож блокирует до них");
  assert.equal(thin.trigger, null);
});

test("neg_streak зовёт правило ВНЕОЧЕРЕДНО, полоса гистерезиса держит сделку, снимок гасит повтор", () => {
  const rows = heldRows(6); // последние шесть часов платим мы
  const t = run({ state: decidedJustNow(ctxAt({ negHours: 0 })), markets: [heldMarket(rows)], position: held({ token: "HELD" }) });
  assert.equal(t.decided, true, "каданс не подошёл, но событие зовёт правило");
  assert.equal(t.trigger, "neg_streak");
  assert.equal(t.decisionEvents[0].hours, 6);
  assert.ok(t.events.some((e) => e.kind === "event" && e.code === "neg_streak"), "событие лежит в ленте тика рядом с перерывами");
  assert.equal(t.kind, "none");
  assert.equal(t.why, "hold_best", "шесть часов из 720 полосу гистерезиса не пробивают: держим");
  assert.equal(t.state.lastDecisionAt, T, "внеочередное решение сдвигает каданс: следующее плановое через сутки от него");
  assert.equal(t.state.lastDecisionCtx.token, "HELD");
  assert.equal(t.state.lastDecisionCtx.negHours, 6, "снимок помнит полосу");
  // Тот же тик на новом снимке: условие держится, а события нет, иначе это каданс 5 минут под другим именем.
  const again = run({ state: t.state, markets: [heldMarket(rows)], position: held({ token: "HELD" }) });
  assert.equal(again.why, "cadence_wait");
  assert.equal(again.decided, false);
  assert.deepEqual(again.decisionEvents, []);
  // Полоса короче порога: события нет.
  const five = run({ state: decidedJustNow(ctxAt()), markets: [heldMarket(heldRows(5))], position: held({ token: "HELD" }) });
  assert.equal(five.why, "cadence_wait");
  // Порог из замороженных параметров взвода.
  const two = run({
    state: decidedJustNow(ctxAt()), markets: [heldMarket(heldRows(2))], position: held({ token: "HELD" }),
  });
  assert.equal(two.why, "cadence_wait", "по умолчанию два часа ниже порога");
  const st2 = armed({ positionId: "p1", lastDecisionAt: T - 1000, lastDecisionCtx: ctxAt(), params: { ...defaultAutoParams(), eventNegHours: 2 } });
  assert.equal(run({ state: st2, markets: [heldMarket(heldRows(2))], position: held({ token: "HELD" }) }).trigger, "neg_streak");
});

test("pot_drop: поток рынка упал вдвое против снимка, снимок обновляется новым потоком", () => {
  const rows = heldRows();
  const live = { bOwnUsd: 1e5, bOtherUsd: 1e6 };
  const rates = { f_long: -4e-11, f_short: 4e-10, b_long: 0, b_short: 0, hl_rate: 0 }; // поток 4e-5 $/с при снимке 1e-4
  const t = run({ state: decidedJustNow(ctxAt({ potUsdPerSec: 1e-4 })), markets: [heldMarket(rows, { live, rates })], position: held({ token: "HELD" }) });
  assert.equal(t.trigger, "pot_drop");
  assert.equal(t.decided, true);
  assert.ok(Math.abs(t.state.lastDecisionCtx.potUsdPerSec - 4e-5) < 1e-15, "снимок обновлён: следующий порог от нового потока");
  const mild = { f_long: -6e-11, f_short: 6e-10, b_long: 0, b_short: 0, hl_rate: 0 };
  const m = run({ state: decidedJustNow(ctxAt({ potUsdPerSec: 1e-4 })), markets: [heldMarket(rows, { live, rates: mild })], position: held({ token: "HELD" }) });
  assert.equal(m.why, "cadence_wait", "минус 40%: порог не взят");
});

test("room_drop: запас до ликвидации сжался на десять пунктов с прошлого решения, сторож ещё молчит", () => {
  const rows = heldRows();
  // Короткая нога GMX при входе 100 умирает на 200. На марке 112 запас 78.6% против 98% в снимке.
  const t = run({ state: decidedJustNow(ctxAt({ roomFrac: 0.98 })), markets: [heldMarket(rows, { markPx: 112 })], position: held({ token: "HELD", markPx: 112 }) });
  assert.equal(t.trigger, "room_drop");
  assert.equal(t.decided, true);
  assert.equal(t.why, "hold_best", "запас 78.6% выше порога сторожа 50%, а правило про поток держит");
  assert.ok(t.state.lastDecisionCtx.roomFrac < 0.8, "снимок обновлён новым запасом");
  const small = run({ state: decidedJustNow(ctxAt({ roomFrac: 0.98 })), markets: [heldMarket(rows, { markPx: 105 })], position: held({ token: "HELD", markPx: 105 }) });
  assert.equal(small.why, "cadence_wait", "сжатие меньше десяти пунктов");
});

test("снимок для событий снимается на каждом решении: вход, удержание, перекладка, кэш", () => {
  // Вход: снимок для рынка входа.
  const open = run({ markets: [rich()] });
  assert.equal(open.kind, "open");
  assert.equal(open.state.lastDecisionCtx.token, open.intent.token);
  assert.equal(open.state.lastDecisionCtx.negHours, 0);
  assert.ok(Number.isFinite(open.state.lastDecisionCtx.roomFrac), "запас кандидата от сторожа входа");
  // Пустой слот без входа: снимка нет.
  const none = run({ markets: [poor()] });
  assert.equal(none.decided, true);
  assert.equal(none.state.lastDecisionCtx, null);
  // Перекладка: снимок для НОВОГО рынка.
  const st = armed({ positionId: "p1", lastDecisionAt: T - 25 * 3600 * 1000 });
  const sw = run({ state: st, markets: [market("HELD", flat({ P: 60, bShort: 1e5 })), rich("RICH")], position: held({ token: "HELD" }) });
  assert.equal(sw.kind, "switch");
  assert.equal(sw.state.lastDecisionCtx.token, "RICH");
});

test("окно назад и горизонт вперёд разнесены: ворота режут по окну, оба числа едут в gate", () => {
  const t = run({ markets: [rich()] });
  assert.equal(t.gate.windowH, FA_SIZING_DEFAULTS.windowH);
  assert.equal(t.gate.horizonH, FA_SIZING_DEFAULTS.horizonH);
  assert.equal(autoWindowH(), FA_SIZING_DEFAULTS.windowH);
  assert.equal(autoViewWindowDays(), autoWindowH() / 24, "панели показывают окно оценки назад");
  const st = armAuto(createAutoState({ nowMs: T }), { nowMs: T, params: { presetId: "fa-uniform-v1" } });
  assert.equal(autoWindowH(st), faSizingPreset("fa-uniform-v1").windowH);
  const bad = armAuto(createAutoState({ nowMs: T }), { nowMs: T, params: { presetId: "нет-такого" } });
  assert.equal(autoWindowH(bad), FA_SIZING_DEFAULTS.windowH);
  // Форма состояния поднимает снимок аддитивно: старой записи без него это «снимка не было».
  assert.equal(ensureAutoState({}).lastDecisionCtx, null);
});
