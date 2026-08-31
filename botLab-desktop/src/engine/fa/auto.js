// auto.js - АВТОМАТ БОТА 1. PURE: ни сети, ни файлов, ни Date.now (`now` приходит параметром).
//
// ЧТО ЭТОТ АВТОМАТ УМЕЕТ И ЧЕГО ОН НЕ УМЕЕТ, ПЕРВЫМ АБЗАЦЕМ И ЧИСЛАМИ.
//
// ДОХОДНОСТЬ ПРАВИЛА ВНЕ ВЫБОРКИ НЕ ВОСПРОИЗВЕДЕНА. На втором периоде проекта правило даёт $214.80
// в год против $429.99 у простого «вошли и держим», то есть база бьёт правило вдвое. Автомат
// строится НЕ потому, что он зарабатывает, а потому, что живых данных о работе правила нет вовсе и
// взять их больше неоткуда: частота промаха исполнения бумажным стендом НЕИЗМЕРИМА в принципе, а
// цена промаха измерена и велика (вершина рейтинга есть неподвижная точка критерия выхода, 0
// срабатываний из 336 по тождеству, а на ранге 2 критерий срабатывает в 60.7% решений).
//
// БОТ БУМАЖНЫЙ И ОСТАЁТСЯ БУМАЖНЫМ: ни ключей, ни подписи, ни размещения ордера. Значит автомат не
// может потерять деньги. Он может сделать другое и худшее: написать в леджер и на экран доход,
// которого у настоящего счёта не было бы. Это ровно дефект фазы 1 (MOODENG $651 526 против $6 812),
// и весь порядок проверок ниже построен против него.
//
// ─────────────────────────────────────────────────────────────────────────────
// ГЛАВНОЕ КОНСТРУКТИВНОЕ РЕШЕНИЕ: `autoTick` НЕ ИСПОЛНЯЕТ, А ВОЗВРАЩАЕТ НАМЕРЕНИЕ
// ─────────────────────────────────────────────────────────────────────────────
//
// Тик возвращает `{ kind: "none" | "open" | "close" | "switch", ... }`, а исполняют его
// `openPosition` / `closePosition` в главном процессе. Причины ровно три, и все три из истории
// проекта: чистота даёт юнит-тест и книгу охраны БЕЗ Electron; бухгалтерия позиции остаётся в одном
// месте; а если бы часть решения жила в главном процессе, книга охраны прогоняла бы НЕ ТУ систему,
// которая работает живьём, и этот класс расхождения проект уже ловил.
//
// СЛОТ ОДИН, ПОРТФЕЛЯ НЕТ. Гипотеза портфеля опровергнута замером: край отбора это уровень рынка, а
// не момент входа. Распределитель капитала `sizeUniverse` при этом зовётся ЦЕЛИКОМ, и из его
// кривых берётся ЛУЧШАЯ годная (`bestAlternative` правила выхода, та же функция, что выбирает
// альтернативу на перекладке). Своей оценки размера или альтернативы здесь нет ни строки.
//
// ─────────────────────────────────────────────────────────────────────────────
// ДВА МЕХАНИЗМА ВМЕСТО ОДНОГО: СБОР И РЕШЕНИЕ. ПРИНЦИП, ВЫВЕДЕННЫЙ ИЗ ОШИБКИ ФАЗЫ 2
// ─────────────────────────────────────────────────────────────────────────────
//
// Ограничения перекрываются, и первое сработавшее прячет остальные. Поэтому:
//   СБОР    - на тике вычисляются ВСЕ применимые коды, и все ложатся в `refusals[]`;
//   РЕШЕНИЕ - решающий код выбирается по ЯВНОМУ реестру приоритетов `FA_AUTO_PRECEDENCE`, который
//             является ДАННЫМИ и проверяется тестом.
// Спрятанный код остаётся видимым в журнале, даже когда решает не он. Пример, ради которого это и
// сделано: после падения приложения одновременно верны `state_stale`, `boot_warmup` и `poll_gap`,
// и одноуровневая проверка показала бы оператору случайный из трёх.
//
// НИ ОДИН ТИК НЕ МОЛЧИТ. Поле `why` не бывает пустым: это либо код автомата из
// `FA_AUTO_REFUSALS`, либо код ПРАВИЛА из его собственного реестра (`FA_SIZING_REFUSALS`,
// `FA_EXIT_REASONS`), либо единственный положительный исход `funded`. Пустой исход это дефект, и
// его ловит тест.
//
// КОДЫ ПРАВИЛ НЕ ПЕРЕПИСЫВАЮТСЯ В РЕЕСТР АВТОМАТА. Копия чужого реестра это вторая реализация,
// которая расходится с оригиналом на первой правке. Когда решать приходится МЕЖДУ кодами правила
// входа, приоритетом служит порядок САМОГО `FA_SIZING_REFUSALS`: он уже упорядочен от снабжения
// (`src_gmx_down`) к экономике (`below_fund_ratio`), и это ровно тот порядок, который нужен. Второго
// списка не заводится.
//
// ─────────────────────────────────────────────────────────────────────────────
// ПОРЯДОК ШАГОВ ТИКА, И ПОРЯДОК ОБОСНОВАН
// ─────────────────────────────────────────────────────────────────────────────
//
// 0. НАЧИСЛЕНИЕ ПЕРВЫМ. Его делают `pollLive` и `settleOpenPositions`, автомат зовётся ПОСЛЕ.
//    Решение по недоначисленному счёту это решение по другим данным.
// 1. НЕПРЕРЫВНОСТЬ. Учёт покрытия и классификация перерыва. Перерыв это СОБЫТИЕ, а не пропуск.
// 2. ВОРОТА СНАБЖЕНИЯ, ВСЕ КОДЫ СРАЗУ. Ворота ОДНИ И ТЕ ЖЕ для входа и для удержания. Основание
//    дословно из шапки `exit.js`: ослабленные ворота выхода означали бы, что выход работает там,
//    где вход бы не вошёл, а эта асимметрия уже стоила проекту целого вывода.
// 3. СРОК ГОДНОСТИ СОСТОЯНИЯ. Старше `decisionMaxAgeH` - решения не принимаются, начисление при
//    этом работает (оно вообще не здесь).
// 4. СТОРОЖ ЗАЛОГА. Блокирующий, первый из решающих, ДО каданса и ДО правила выхода. Две причины:
//    его отказ невосстановим последующим решением, и каданс отвечает на вопрос про цену круга, а
//    сторож про выживание. На открытой сделке зовётся КАЖДЫЙ тик, а не на тике решения.
// 5. Дальше каданс, правило выхода, правило входа.
//
// ПОЧЕМУ ПРАВИЛА ЗОВУТСЯ НЕ КАЖДЫЙ ТИК, А НА ТИКЕ РЕШЕНИЯ. Это не экономия и не лень: замер цены
// круга (`FA_EXIT_DEFAULTS.decisionIntervalHours`) даёт то же нетто при кадансе 24 ч, что при 1 ч,
// за 27 кругов вместо 44 и вчетверо реже впадая в храповик по размеру. Цена вызова тоже названа:
// правило входа перебирает сетку размеров, начисляя на каждом узле 720 часов, и книга охраны
// правила выхода тратит на 336 решений по трём рынкам около 30 секунд, то есть порядка 30 мс на
// рынок-решение. На пяти рынках это около 150 мс на решение, при кадансе 24 ч незаметно и при
// кадансе 5 минут неприемлемо. Дешёвые ворота (непрерывность, снабжение, сторож залога) считаются
// КАЖДЫЙ тик, дорогие правила только на тике решения.
//
// ─────────────────────────────────────────────────────────────────────────────
// ГДЕ ЛЕЖИТ ТУМБЛЕР, И ЭТО РАСХОЖДЕНИЕ С ПЛАНОМ, НАЗВАННОЕ ЯВНО
// ─────────────────────────────────────────────────────────────────────────────
//
// Тумблер лежит в СОСТОЯНИИ (`funding-arb-auto.json`), а не в настройках. План говорил «в
// настройках на диске»; бот 2 держит свой в состоянии вместе с `armedAt`, замороженными параметрами
// и накопителем сделок. Разнесение по двум файлам допускает состояние «включён, но параметров нет»,
// а параметры замораживаются РОВНО в момент взвода и обязаны лежать рядом с ним. Буква «на диске, а
// не в памяти» соблюдена, буква «в настройках» нет.
//
// ПАРАМЕТРЫ ЗАМОРАЖИВАЮТСЯ ПРИ ВЗВОДЕ и не следуют за правкой значений по умолчанию: сделка,
// открытая одним набором чисел, обязана сопровождаться тем же набором до самого закрытия (закон
// заморозки при открытии, идиома бота 2).
//
// ЧИСЛА ВЛАДЕЛЬЦА, ПРИНЯТЫЕ 2026-08-31 И НЕ ПЕРЕОТКРЫВАЕМЫЕ: плечо 1 на каждую ногу, запас до
// ликвидации 50%, депозит $5000, ноционал $2500 на ногу. ЗАЯВЛЕННЫЙ И ФАКТИЧЕСКИЙ РАЗМЕР ЭТО РАЗНЫЕ
// ЧИСЛА, и в паспорте сделки пишутся оба: сетка размеров логарифмическая с шагом 0.1 декады,
// соседние достижимые размеры отличаются на 26%, капитал округляется вниз до узла, и $2500
// работают как $1995.26, то есть 20.2% простаивает (замер, шапка `sizing.js`).
//
// СРОК ГОДНОСТИ РЕШЕНИЯ 72 ЧАСА ЭТО ДОПУЩЕНИЕ. Замер распада сигнала даёт КРИВУЮ потерь
// (устаревание на 24 ч снимает 6.6% годового нетто, на 72 ч 15%, на 240 ч 35%, на 720 ч 86%), но не
// ПОРОГ: порог это выбор, и 72 часа выбраны, а не измерены.
//
// ЧЕГО МОДУЛЬ НЕ ИМПОРТИРУЕТ: ничего из `src/engine/btcopt/`. У бота 2 идёт живой прогон, замыкания
// импортов двух ботов пересекаются по пустому множеству, и это стережёт тест. Порог перерыва опроса
// и словарь его причин берутся у `fa/record.js`, а не переписываются: это единственная в боте 1
// реализация непрерывности, и вторая её копия разошлась бы с архивом.

import { DEFAULT_COSTS } from "../costs.js";
import { annualizeRow } from "../math.js";
import { legModel } from "../paper.js";
import { FA_SIZING_DEFAULTS, FA_SIZING_REFUSALS, faSizingPreset, sizeUniverse } from "./sizing.js";
import { FA_EXIT_DEFAULTS, FA_EXIT_REASONS, bestAlternative, decideExit, shouldDecideNow } from "./exit.js";
import { FA_MARGIN_DEFAULTS, FA_MARGIN_REFUSALS, marginGuard, positionLegs } from "./margin.js";
import { baseCoverage } from "./bases.js";
import { FA_GAP_SLOTS, classifyFaGap } from "./record.js";

const HOUR_MS = 3600 * 1000;

export const AUTO_SCHEMA_VERSION = 1;
export const FA_AUTO_BOT_ID = "funding-arb-auto";

// ─────────────────────────────────────────────────────────────────────────────
// ПАРАМЕТРЫ. Каждое число названо: ЗАМЕР или ДОПУЩЕНИЕ.
// ─────────────────────────────────────────────────────────────────────────────
export function defaultAutoParams() {
  return {
    // Пресет правила размера. ЧИСТЫЕ ДАННЫЕ: ветки исполнения от его имени не зависят.
    presetId: "fa-per-market-h720-v1",
    // Потолок капитала на СДЕЛКУ, он же ноционал ноги. РЕШЕНИЕ ВЛАДЕЛЬЦА: $2500 на ногу при
    // депозите $5000 и плече 1 на каждую из двух ног.
    capitalUsd: 2500,
    // Плечо на КАЖДУЮ ногу. РЕШЕНИЕ ВЛАДЕЛЬЦА.
    leverage: FA_MARGIN_DEFAULTS.leverage,
    // Требуемый запас хода до цены ликвидации любой ноги. РЕШЕНИЕ ВЛАДЕЛЬЦА.
    minRoomFraction: FA_MARGIN_DEFAULTS.minRoomFraction,
    // Каданс решения. ЗАМЕР: 24 ч дают то же нетто, что 1 ч, за 27 кругов вместо 44.
    cadenceH: FA_EXIT_DEFAULTS.decisionIntervalHours,
    // Срок годности состояния. ДОПУЩЕНИЕ (см. шапку): замерена кривая, а не порог.
    decisionMaxAgeH: 72,
    // Требуемая доля часов окна с НАБЛЮДЁННОЙ базой фандинга. ДОПУЩЕНИЕ, назначенное владельцем
    // 2026-08-31 после того, как цена обоих краёв была названа. Замером порог НЕ выведен, и это
    // главное, что надо знать читателю.
    //
    // ЧТО ИЗМЕРЕНО: часов без базы в самих данных 0.052% (288 из 551 943), то есть на окне в
    // 720 часов ожидается 0.38 дыры. ЧТО НЕ ИЗМЕРЕНО и решило дело: дыры от ПЕРЕРЫВОВ ОПРОСА
    // (ноутбук спит, приложение закрыто), а их частота станет известна только из живой записи.
    //
    // ЦЕНА ОБОИХ КРАЁВ, названная до выбора. Значение 1 (буквальное чтение решения «пока не
    // накопится 720 часов, правило входа отказывает») даёт ноль риска решения по неполным данным
    // и риск НИКОГДА НЕ ВОЙТИ: всякая дыра откладывает решение до её выхода из окна, а с учётом
    // перерывов опроса бот может молчать месяцами. Значение 0.95 терпит 36 дыр на окно, но
    // занижает брутто удержания до 5%, а ложный выход в кэш стоит круга ($8.75 на $2500).
    //
    // Выбрано 0.95: риск не войти вовсе оценён дороже, чем 5% занижения. Пересмотреть надо ЗАМЕРОМ
    // частоты дыр на реальном опросе, и такой замер станет возможен, как только поработает запись
    // фазы 5. Ровно поэтому это параметр, а не константа.
    //
    // ПОЧЕМУ ГЕЙТ ВООБЩЕ НУЖЕН, ХОТЯ СМЕЩЕНИЕ ОДНОСТОРОННЕЕ. Для ВХОДА неполное покрытие безопасно
    // по построению: час без базы теряет доход, значит оценка занижена, значит ошибиться она может
    // только отказом. Для УДЕРЖАНИЯ это неверно и стоит денег: заниженное брутто удержания толкает
    // правило выхода в кэш (`gross_negative`) и в перекладку, а каждое такое решение стоит круга.
    // Ворота обязаны быть одни и те же, поэтому гейт стоит на обеих ветках.
    baseCoverageMin: 0.95,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// РЕЕСТРЫ. Дисциплина та же, что у `FA_SIZING_REFUSALS` и `FA_EXIT_REASONS`: замороженный список,
// тест достижимости в ОБЕ стороны, русский текст отдельной таблицей.
// ─────────────────────────────────────────────────────────────────────────────

// Намерение тика. Исполняют его снаружи.
export const FA_AUTO_INTENTS = Object.freeze(["none", "open", "close", "switch"]);

// Положительный исход у автомата ровно один: правило входа профинансировало рынок и слот занят.
// Все прочие названные исходы приходят из реестров правил, а не отсюда.
export const FA_AUTO_OUTCOMES = Object.freeze(["funded"]);

// СОБСТВЕННЫЕ отказы автомата. Коды правил сюда не переписываются.
export const FA_AUTO_REFUSALS = Object.freeze([
  "state_corrupt", // состояние не прочиталось и было отправлено в карантин
  "off", // тумблер выключен
  "orphan_position", // автомат помнит позицию, которой в леджере нет: бухгалтерия разошлась
  "state_stale", // состояние старше срока годности решения
  "boot_warmup", // первый тик после старта процесса: непрерывность ещё не наблюдалась
  "poll_gap", // перерыв опроса: срез и трейлинг на этом тике не непрерывны
  ...FA_MARGIN_REFUSALS, // сторож залога заводит свои коды сам, здесь они переиспользуются ССЫЛКОЙ
  "capital_missing", // потолок капитала не назван: правило размера обязано отказать, а не занять всё
  "hist_short", // трейлинга меньше горизонта: оценка была бы в других единицах
  "hist_no_base", // баз фандинга на окне меньше требуемого: накопление вперёд ещё идёт
  "no_slot", // слот занят позицией, которую автомат не открывал
  "stop_pending", // запрошена остановка: новых входов нет
  "cadence_wait", // каданс решения не подошёл
]);

// ПРИОРИТЕТ РЕШАЮЩЕГО КОДА. ДАННЫЕ, а не порядок операторов в функции. Каждая строка обязана быть
// достижима как РЕШАЮЩАЯ, иначе реестр обещает то, чего не бывает (урок развода реестров отказов и
// связывающих в `sizing.js`).
//
// ПОЧЕМУ ИМЕННО ТАК. Сверху вниз идёт от «системы нет» к «системе нечего делать»:
//   состояние не прочиталось > выключен > бухгалтерия разошлась > данные слишком стары >
//   не наблюдали непрерывности > сторож залога > снабжение > слот > остановка > каданс.
// Срок годности состояния стоит ВЫШЕ бута и перерыва нарочно: после многодневного простоя верны все
// три, и самое сильное утверждение о качестве решения делает именно он.
export const FA_AUTO_PRECEDENCE = Object.freeze([
  "state_corrupt",
  "off",
  "orphan_position",
  "state_stale",
  "boot_warmup",
  "poll_gap",
  "margin_unknown",
  "margin_thin",
  "capital_missing",
  "hist_short",
  "hist_no_base",
  "no_slot",
  "stop_pending",
  "cadence_wait",
]);

const REFUSAL_TEXT = Object.freeze({
  state_corrupt: "состояние автомата было битым и отправлено в карантин",
  off: "автомат выключен",
  orphan_position: "автомат помнит сделку, которой в леджере нет",
  state_stale: "состояние старше срока годности решения",
  boot_warmup: "первый тик после запуска: непрерывность ещё не наблюдалась",
  poll_gap: "перерыв опроса: срез и трейлинг не непрерывны",
  margin_thin: "запас до ликвидации ноги меньше требуемого",
  margin_unknown: "запас до ликвидации посчитать нечем",
  capital_missing: "потолок капитала не назван",
  hist_short: "истории меньше горизонта",
  hist_no_base: "наблюдённых баз фандинга на окне не хватает",
  no_slot: "слот занят чужой позицией",
  stop_pending: "запрошена остановка: новых входов нет",
  cadence_wait: "каданс решения не подошёл",
  funded: "правило входа профинансировало рынок",
});

// ─────────────────────────────────────────────────────────────────────────────
// СОСТОЯНИЕ. Форма ОДНА на создание, подъём старой записи и все точки входа: две формы это второй
// способ разойтись (идиома `ensureSellChain` бота 2, найденная живым развёртыванием).
// ─────────────────────────────────────────────────────────────────────────────
export function createAutoState({ nowMs = null } = {}) {
  return ensureAutoState({ schemaVersion: AUTO_SCHEMA_VERSION, botId: FA_AUTO_BOT_ID, createdAt: nowMs });
}

// Аддитивный подъём: отсутствующее поле читается как «его не было», а не как ошибка. Мутирует
// переданный объект и возвращает его же, как `ensureSellChain`, потому что зовут его из нескольких
// точек и вторая форма возврата провоцировала бы забыть присваивание.
export function ensureAutoState(st) {
  const s = st && typeof st === "object" ? st : {};
  if (s.schemaVersion == null) s.schemaVersion = AUTO_SCHEMA_VERSION;
  if (s.botId == null) s.botId = FA_AUTO_BOT_ID;
  if (s.createdAt === undefined) s.createdAt = null;
  if (s.on == null) s.on = false;
  if (s.stopRequested == null) s.stopRequested = false;
  // "continuous" - искать следующий вход после закрытия; "once" - одна сделка и выключиться.
  if (s.mode !== "once") s.mode = "continuous";
  if (s.armedAt === undefined) s.armedAt = null;
  if (s.stoppedAt === undefined) s.stoppedAt = null;
  if (s.params === undefined) s.params = null;
  if (s.positionId === undefined) s.positionId = null;
  if (s.lastTickAt === undefined) s.lastTickAt = null;
  if (s.lastDecisionAt === undefined) s.lastDecisionAt = null;
  if (s.lastRefusals === undefined || !Array.isArray(s.lastRefusals)) s.lastRefusals = [];
  if (!s.uptime || typeof s.uptime !== "object") {
    s.uptime = { ticks: 0, firstAt: null, lastAt: null, maxGapMs: 0, gaps: [], nominalSec: null };
  }
  if (!Array.isArray(s.uptime.gaps)) s.uptime.gaps = [];
  return s;
}

// ВЗВОД. Параметры замораживаются ЗДЕСЬ и только здесь: сделка, открытая одним набором чисел,
// обязана сопровождаться тем же набором до закрытия. Накопитель непрерывности обнуляется, потому
// что покрытие заявляется за период работы автомата, а не за жизнь файла.
export function armAuto(st, { nowMs, params = null, mode = "continuous" } = {}) {
  const s = ensureAutoState(st);
  s.on = true;
  s.stopRequested = false;
  s.mode = mode === "once" ? "once" : "continuous";
  s.armedAt = nowMs ?? null;
  s.stoppedAt = null;
  s.params = Object.freeze({ ...defaultAutoParams(), ...(params || {}) });
  s.uptime = { ticks: 0, firstAt: null, lastAt: null, maxGapMs: 0, gaps: [], nominalSec: null };
  s.lastRefusals = [];
  return s;
}

// ОСТАНОВКА. `immediate` выключает сразу; иначе запрашивается остановка, и автомат перестаёт
// ВХОДИТЬ, но открытую сделку продолжает вести правилом выхода до её закрытия. Бросать открытую
// сделку без присмотра нельзя: у неё есть сторож залога, и он работает только пока автомат тикает.
export function stopAuto(st, { nowMs, immediate = false } = {}) {
  const s = ensureAutoState(st);
  if (immediate || !s.positionId) {
    s.on = false;
    s.stopRequested = false;
    s.stoppedAt = nowMs ?? null;
  } else {
    s.stopRequested = true;
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНОЕ
// ─────────────────────────────────────────────────────────────────────────────

// Приоритет среди кодов ПРАВИЛА ВХОДА берётся из порядка его собственного реестра. Кода вне реестра
// не проглатывается: он возвращается как есть и виден в журнале.
function sizingDecider(codes) {
  let best = null;
  let bestIdx = Infinity;
  let unknown = null;
  for (const c of codes) {
    const i = FA_SIZING_REFUSALS.indexOf(c);
    if (i < 0) { if (unknown == null) unknown = c; continue; }
    if (i < bestIdx) { bestIdx = i; best = c; }
  }
  return best ?? unknown;
}

// Решающий код среди СОБСТВЕННЫХ кодов автомата. Кода вне реестра приоритетов здесь быть не может:
// в `refusals[]` его кладёт только этот модуль, и тест сверяет множества в обе стороны.
function precedenceDecider(codes) {
  for (const c of FA_AUTO_PRECEDENCE) if (codes.has(c)) return c;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// СВЕДЕНИЕ НОГ В ОДНО ЧИСЛО. Живая котируемая ставка схемы, годовых на доллар ноционала.
//
// СЧИТАЕТСЯ ЗДЕСЬ, А НЕ В ИНТЕРФЕЙСЕ, и это не вкусовщина: разбор схемы на ноги знает `legModel`,
// перевод факторов в годовые знает `annualizeRow`, и обе таблицы уже есть. Вторая копия этих двух
// правил в отрисовщике разошлась бы с движком на первой же правке знаков, а знаки у бота 1 один раз
// уже стоили целого вывода.
//
// ЭТО КОТИРУЕМАЯ СТАВКА, А НЕ НАША: разбавление собственным входом здесь не применяется. Долю
// удержания правило считает отдельно и она едет своим полем.
// ─────────────────────────────────────────────────────────────────────────────
export function legSpreadApr(rates, strategy, config) {
  if (!rates) return null;
  const need = strategy === "one"
    ? ["f_short", "b_short"]
    : ["f_long", "f_short", "b_long", "b_short", "hl_rate"];
  for (const k of need) if (!Number.isFinite(rates[k])) return null;
  const a = annualizeRow({ f_long: rates.f_long ?? 0, f_short: rates.f_short, b_long: rates.b_long ?? 0, b_short: rates.b_short, hl_rate: rates.hl_rate ?? 0 });
  if (strategy === "one") return a.gmx_short_recv - a.gmx_borrow_short;
  return legModel("two", config).gmxSide === "short" ? a.net_A : a.net_B;
}

// ─────────────────────────────────────────────────────────────────────────────
// СВОДКА ПОСЛЕДНЕЙ ОЦЕНКИ ПО РЫНКАМ. Одна строка на рынок вселенной, ВКЛЮЧАЯ те, до правила
// размера не дошедшие: рынок, отсеянный воротами снабжения, кривой не имеет вовсе, и без этой
// склейки он пропал бы из сводки молча, то есть читатель решил бы, что вселенная меньше, чем есть.
//
// РАНГ СЧИТАЕТСЯ ТЕМ ЖЕ ПРЕДИКАТОМ, ЧТО И ВЫБОР: годная это профинансированная кривая, ВЛЕЗАЮЩАЯ в
// доступный капитал (`bestAlternative`). Рынок профинансированный, но не влезающий, ранга не
// получает, и его размер стоит рядом, чтобы причина была видна числом.
// ─────────────────────────────────────────────────────────────────────────────
function evalSummary({ markets, gateByToken, curves, capitalUsd }) {
  const byToken = new Map();
  for (const c of curves || []) if (c && c.token) byToken.set(c.token, c);
  const ranked = (curves || [])
    .filter((c) => c && !c.refusal && c.sizeUsd > 0 && c.sizeUsd <= capitalUsd)
    .sort((a, b) => b.netUsd - a.netUsd);
  const rankOf = new Map(ranked.map((c, i) => [c.token, i + 1]));
  return (markets || []).map((m) => {
    const gate = gateByToken.get(m.token) || {};
    const cur = byToken.get(m.token) || null;
    const refusal = gate.code ?? (cur ? cur.refusal : "hist_short");
    return {
      token: m.token,
      strategy: m.strategy ?? (m.config ? "two" : "one"),
      config: m.config ?? null,
      refusal: refusal ?? null,
      funded: !!(cur && !cur.refusal),
      binding: cur ? cur.binding ?? null : null,
      sizeUsd: cur && Number.isFinite(cur.sizeUsd) ? cur.sizeUsd : null,
      netUsd: cur && Number.isFinite(cur.netUsd) ? cur.netUsd : null,
      rank: rankOf.get(m.token) ?? null,
      coverage: Number.isFinite(gate.coverage) ? gate.coverage : null,
      dilutionRetained: cur && Number.isFinite(cur.dilutionRetained) ? cur.dilutionRetained : null,
      // СТАВКА НА МОМЕНТ ОЦЕНКИ, а не «сейчас». Замораживается вместе со всей строкой: строка
      // описывает ОДНО наблюдение, и живое число в ней означало бы, что часть колонок относится к
      // суткам назад, а одна к текущей минуте. Одна строка - одно время.
      legApr: legSpreadApr(m.rates, m.strategy ?? (m.config ? "two" : "one"), m.config),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ТИК. Возвращает НОВОЕ состояние и намерение; ничего не исполняет и ничего не пишет.
//
//   now, bootAt   - метки времени; своих часов у модуля нет;
//   state         - персистентное состояние автомата (поднятое `ensureAutoState`);
//   corrupt       - состояние читалось с карантином (битый JSON);
//   markets       - вселенная в форме, которую принимает `sizeUniverse`, с ПОЛНЫМИ строками кадра:
//                   нарезку по горизонту делает автомат, потому что сравнивать нетто на окнах
//                   разной длины значит сравнивать разные единицы;
//   position      - НАША открытая сделка в форме правила выхода плюс `id`, `entryPx`, `markPx`;
//   foreignOpen   - в леджере есть открытая позиция, которую автомат не открывал;
//   nominalSec    - номинальный интервал опроса, для порога перерыва.
// ─────────────────────────────────────────────────────────────────────────────
export function autoTick({
  now, bootAt = null, state = null, corrupt = false,
  markets = [], sources = null, costs = DEFAULT_COSTS,
  position = null, foreignOpen = false,
  nominalSec = null, gapHints = {},
} = {}) {
  const st = ensureAutoState(state ? { ...state, uptime: { ...state.uptime, gaps: [...(state.uptime?.gaps || [])] } } : null);
  const refusals = [];
  const events = [];
  // ДВА СПИСКА ВМЕСТО ОДНОГО, И РАЗНИЦА МЕЖДУ НИМИ СОДЕРЖАТЕЛЬНАЯ. `note` кладёт код в журнал, но
  // не даёт ему решать; `add` кладёт и допускает к выбору решающего. Пер-рыночный отказ обязан быть
  // виден оператору, но не имеет права остановить тик: один рынок без истории это причина не
  // рассматривать ЕГО, а не причина не решать вовсе. Слитый в одно список ровно это и делал бы.
  const blocking = new Set();
  const note = (code, extra = null) => { refusals.push({ code, ...(extra || {}) }); };
  const add = (code, extra = null) => { note(code, extra); blocking.add(code); };
  const params = st.params ? { ...defaultAutoParams(), ...st.params } : defaultAutoParams();
  const preset = faSizingPreset(params.presetId) || {};
  const capOk = Number.isFinite(params.capitalUsd) && params.capitalUsd > 0;
  const cfg = {
    ...FA_SIZING_DEFAULTS,
    ...preset,
    // ПОТОЛОК ТИКЕТА НЕ ИМЕЕТ ПРАВА БЫТЬ ВЫШЕ КАПИТАЛА СДЕЛКИ, и это не новое правило, а его
    // собственный параметр, приведённый к физике счёта. Без приведения автомат не входил бы ВООБЩЕ:
    // потолок тикета правила это $5000, капитал владельца на сделку $2500, а годной альтернативой
    // считается только та, что ВЛЕЗАЕТ в доступный капитал (`bestAlternative`). То есть все рынки,
    // чей оптимум упирается в потолок тикета, а это лучшие рынки, отсеивались бы молча по размеру,
    // которым мы всё равно не вошли бы. Приведение строго консервативно (потолок только опускается)
    // и попадает в запись отдельным полем `cfgd`, то есть архив видит отклонение от пресета.
    //
    // ОДИН И ТОТ ЖЕ `cfg` ИДЁТ И ВО ВХОД, И В ВЫХОД. Разные потолки на двух ветках дали бы ровно ту
    // асимметрию ворот, которая проекту уже стоила целого вывода.
    ticketCapUsd: capOk
      ? Math.min(preset.ticketCapUsd ?? FA_SIZING_DEFAULTS.ticketCapUsd, params.capitalUsd)
      : (preset.ticketCapUsd ?? FA_SIZING_DEFAULTS.ticketCapUsd),
  };
  const H = cfg.horizonH;

  // ── ШАГ 1. НЕПРЕРЫВНОСТЬ. Считается ДО всего остального и независимо от тумблера: перерыв это
  // свойство опроса, а не свойство решения, и оценивать его задним числом будет нечем.
  const nom = Number.isFinite(nominalSec) && nominalSec > 0 ? nominalSec : null;
  const prevTickAt = st.lastTickAt;
  const u = st.uptime;
  let gapMs = 0;
  if (Number.isFinite(prevTickAt) && Number.isFinite(now)) gapMs = Math.max(0, now - prevTickAt);
  if (nom != null && gapMs > nom * 1000 * FA_GAP_SLOTS) {
    const cause = classifyFaGap({ fromMs: prevTickAt, toMs: now, hints: { ...gapHints, bootAt: gapHints.bootAt ?? bootAt } });
    const gap = { at: prevTickAt, ms: gapMs, lost: Math.max(0, Math.round(gapMs / (nom * 1000)) - 1), cause };
    u.gaps.push(gap);
    if (u.gaps.length > 50) u.gaps.shift(); // хвост важнее головы: свежие перерывы объяснимы
    events.push({ kind: "gap", ...gap });
    add("poll_gap", { ms: gapMs, cause });
  }
  u.ticks += 1;
  if (u.firstAt == null) u.firstAt = now;
  if (gapMs > u.maxGapMs) u.maxGapMs = gapMs;
  u.lastAt = now;
  if (nom != null) u.nominalSec = nom;
  st.lastTickAt = now;

  // ── ШАГ 1a. СОСТОЯНИЕ И ТУМБЛЕР.
  if (corrupt) add("state_corrupt");
  if (!st.on) add("off");
  if (Number.isFinite(bootAt) && (!Number.isFinite(prevTickAt) || prevTickAt < bootAt)) add("boot_warmup");
  // Возраст состояния это молчание автомата, а не возраст файла: после многодневного простоя
  // решение принималось бы по данным, чью связь с прошлым решением никто не наблюдал.
  const silenceH = Number.isFinite(prevTickAt) ? (now - prevTickAt) / HOUR_MS : 0;
  if (silenceH > params.decisionMaxAgeH) add("state_stale", { silenceH });

  // ── ШАГ 1b. БУХГАЛТЕРИЯ СЛОТА. Слот ОДИН.
  if (st.positionId && !position) add("orphan_position", { positionId: st.positionId });
  if (!st.positionId && foreignOpen) add("no_slot");
  if (!st.positionId && !foreignOpen && st.stopRequested) add("stop_pending");

  // ── ШАГ 2. ВОРОТА СНАБЖЕНИЯ, ВСЕ КОДЫ СРАЗУ. Ворота ОДНИ И ТЕ ЖЕ для входа и для удержания.
  if (!Number.isFinite(params.capitalUsd) || params.capitalUsd <= 0) add("capital_missing");
  // Коды ПРАВИЛА, а не автомата: отказ источника обрабатывают `sizeUniverse` и `decideExit`, и
  // решать он будет их собственным кодом. Здесь он только называется на КАЖДОМ тике, иначе на
  // тике без решения отказ снабжения был бы невидим вовсе.
  if (sources && sources.gmxDown) note("src_gmx_down");
  if (sources && sources.hlDown) note("src_hl_down");

  // Нарезка окна и покрытие базами по КАЖДОМУ рынку. Рынок, не прошедший ворота, из вселенной
  // выбывает: правило входа не проверяет длину окна само и посчитало бы нетто на 100 часах против
  // 720 у соседа, то есть сравнило бы разные единицы.
  const usable = [];
  const heldToken = position?.token ?? null;
  let heldGate = null;
  let anyShort = false;
  // Лучшее наблюдённое покрытие баз на окне. Нужно ИНТЕРФЕЙСУ: отказ `hist_no_base` это штатное
  // состояние первых недель, и без числа он неотличим от поломки. Считается здесь, потому что
  // окно нарезано здесь; второй счёт снаружи разошёлся бы с воротами на первой же правке.
  let covBest = null;
  // Исход ворот ПО КАЖДОМУ рынку, для сводки последней оценки. Пер-рыночные отказы уезжают в
  // журнал общим списком и наружу режутся решающим кодом, поэтому рынок, отсеянный воротами, из
  // кривых правила пропадает целиком: без этой пометки его строка в сводке была бы пустой без
  // причины.
  const gateByToken = new Map();
  for (const m of markets || []) {
    const rows = m?.rows || [];
    if (rows.length < H) {
      anyShort = true;
      note("hist_short", { token: m?.token ?? null, rows: rows.length, need: H });
      if (m?.token != null) gateByToken.set(m.token, { code: "hist_short", coverage: null });
      if (m?.token === heldToken) heldGate = "hist_short";
      continue;
    }
    const win = rows.slice(rows.length - H);
    // Сторона ноги GMX берётся у `legModel` леджера, а не выводится здесь по конфигурации: это
    // единственное место в проекте, которое знает разбор схемы на ноги.
    const cov = baseCoverage(win, legModel(m.strategy || "two", m.config).gmxSide);
    if (covBest == null || cov.fraction > covBest) covBest = cov.fraction;
    if (cov.fraction < params.baseCoverageMin) {
      note("hist_no_base", { token: m.token, covered: cov.covered, hours: cov.hours, need: params.baseCoverageMin });
      gateByToken.set(m.token, { code: "hist_no_base", coverage: cov.fraction });
      if (m.token === heldToken) heldGate = "hist_no_base";
      continue;
    }
    gateByToken.set(m.token, { code: null, coverage: cov.fraction });
    usable.push({ ...m, rows: win, coverage: cov });
  }
  // ТИКОВЫЙ ГЕЙТ, а не пер-рыночный. Блокирует ровно два состояния: рынок, на котором мы СТОИМ,
  // ворота не прошёл (оценивать удержание нечем, а действовать вслепую хуже, чем подождать), либо
  // годных рынков не осталось вовсе (решать не о чем). Отказ отдельного рынка при этом тик не
  // останавливает: он лежит в журнале со своим токеном и виден.
  if (heldGate) add(heldGate, { where: "held", token: heldToken });
  else if (!usable.length) add(anyShort || !(markets || []).length ? "hist_short" : "hist_no_base", { where: "universe" });
  const byToken = new Map(usable.map((m) => [m.token, m]));

  // ── ШАГ 4. СТОРОЖ ЗАЛОГА ОТКРЫТОЙ СДЕЛКИ. Каждый тик, до каданса и до правила выхода.
  let margin = null;
  if (position) {
    margin = marginGuard({
      legs: positionLegs({
        strategy: position.strategy, config: position.config, sizeUsd: position.sizeUsd,
        leverage: params.leverage, entryPx: position.entryPx, markPx: position.markPx,
        hlMaxLev: position.hlMaxLev,
      }),
      minRoomFraction: params.minRoomFraction,
    });
    if (margin.code) add(margin.code, { where: "position", roomFrac: margin.roomFrac });
  }

  // ── ШАГ 5. КАДАНС. Сторож залога его перебивает: его отказ невосстановим следующим решением.
  const marginForces = !!(position && margin && margin.code);
  const cadenceOk = shouldDecideNow(st.lastDecisionAt, now, params.cadenceH);
  if (!cadenceOk && !marginForces) add("cadence_wait");

  // ── РЕШЕНИЕ. Блокирующий код автомата решает раньше любого правила.
  const decider = precedenceDecider(blocking);
  // ВОРОТА СНАБЖЕНИЯ ЧИСЛОМ, на КАЖДОМ исходе. Заведено для интерфейса фазы 6: правило показа
  // требует причину числами («покрытие 0.87 при требуемых 0.95»), а считать её второй раз снаружи
  // запрещено законом проекта. Ничего не решает и ни на одну ветку не влияет.
  const gate = Object.freeze({
    markets: (markets || []).length, usable: usable.length, held: heldGate,
    covBest, covNeed: params.baseCoverageMin, horizonH: H,
  });
  const out = (kind, why, extra = null) => {
    st.lastRefusals = [...new Set(refusals.map((r) => r.code))];
    return { kind, why, refusals, events, state: st, margin, gate, decided: false, intent: null, universe: null, exit: null, window: null, evalMarkets: null, params, cfg, ...(extra || {}) };
  };

  if (decider) {
    // ТОНКИЙ ЗАПАС НА ОТКРЫТОЙ СДЕЛКЕ ЭТО НЕ «НИЧЕГО НЕ ДЕЛАЕМ», А ТРЕБОВАНИЕ ЗАКРЫТИЯ: отказ
    // сторожа невосстановим следующим решением, и ждать каданса значит ждать ликвидации.
    //
    // А НЕИЗВЕСТНЫЙ ЗАПАС ЗАКРЫТИЯ НЕ ТРЕБУЕТ, и разница принципиальна. `margin_thin` это
    // ИЗМЕРЕННАЯ опасность; `margin_unknown` это отказ снабжения (цены нет, предельного плеча нет).
    // Закрываться по нему значит платить круг издержек за икоту источника, то есть превращать
    // отказ снабжения в вывод правила, а этот класс дефекта проекту уже стоил целого вывода.
    if (position && decider === "margin_thin") {
      return out("close", decider, { intent: closeIntent(position, decider) });
    }
    return out("none", decider);
  }

  // ── ПРАВИЛА. Дорогая часть, и она зовётся ЦЕЛИКОМ. Своей оценки размера или альтернативы у
  // автомата нет ни строки.
  // Окно, поданное правилу. Пришпиливает решение к тем самым часам, на которых оно принято: без
  // этих трёх чисел задним числом нельзя отличить плохое решение от решения по другим данным.
  const windowOf = (m) => (m && m.rows.length
    ? { firstTsHour: m.rows[0].tsHour, lastTsHour: m.rows[m.rows.length - 1].tsHour, rows: m.rows.length }
    : null);

  if (position) {
    // ТЕКУЩИЙ РЫНОК ОБЯЗАН ВХОДИТЬ ВО ВСЕЛЕННУЮ: перекладка в тот же рынок другим размером законна
    // и именно так выражается изменение размера. Ворота выше его уже пропустили, иначе решать было
    // бы нечем и мы вышли бы кодом ворот.
    const held = usable.find((m) => m.token === position.token) || null;
    const ex = decideExit({
      position: { token: position.token, config: position.config, strategy: position.strategy, sizeUsd: position.sizeUsd },
      rows: held ? held.rows : null,
      markets: usable, capitalAvailableUsd: params.capitalUsd, costs, cfg, sources,
    });
    st.lastDecisionAt = now;
    // Вселенная для записи собирается ИЗ ОТВЕТА ПРАВИЛА ВЫХОДА, а не считается второй раз: оно уже
    // позвало правило входа по всем рынкам, и второй вызов дал бы другие кривые тем же данным.
    const base = {
      decided: true, exit: ex, universe: { curves: ex.curves, refusals: ex.refusals, cfg: ex.cfg }, window: windowOf(held),
      evalMarkets: evalSummary({ markets, gateByToken, curves: ex.curves, capitalUsd: params.capitalUsd }),
    };
    for (const r of ex.refusals || []) note(r.refusal, { token: r.token, from: "sizing" });
    if (ex.action === "close") return out("close", ex.reason, { ...base, intent: closeIntent(position, ex.reason) });
    if (ex.action === "switch") {
      const guard = entryGuard(ex.best, byToken.get(ex.best.token), params);
      if (guard.code) {
        add(guard.code, { where: "candidate", token: ex.best.token, roomFrac: guard.roomFrac });
        return out("none", guard.code, { ...base, margin: guard });
      }
      return out("switch", ex.reason, { ...base, margin: guard, intent: switchIntent(position, ex.best, byToken.get(ex.best.token), params, ex.reason) });
    }
    return out("none", ex.reason, base);
  }

  // Слот пуст: правило ВХОДА целиком, распределитель зовётся своей единственной точкой входа.
  const uni = sizeUniverse({ markets: usable, costs, capitalTotal: params.capitalUsd, cfg, sources });
  st.lastDecisionAt = now;
  const base = {
    decided: true, universe: uni, window: windowOf(usable[0]),
    evalMarkets: evalSummary({ markets, gateByToken, curves: uni.curves, capitalUsd: params.capitalUsd }),
  };
  const best = bestAlternative(uni.curves, params.capitalUsd);
  for (const r of uni.refusals || []) note(r.refusal, { token: r.token, from: "sizing" });
  if (!best) {
    const why = sizingDecider((uni.refusals || []).map((r) => r.refusal).filter(Boolean));
    // Вселенная пуста и отказов нет вовсе: это не молчание, а отсутствие рынков, и код у него свой.
    return out("none", why ?? "hist_short", base);
  }
  const guard = entryGuard(best, byToken.get(best.token), params);
  if (guard.code) {
    add(guard.code, { where: "candidate", token: best.token, roomFrac: guard.roomFrac });
    return out("none", guard.code, { ...base, margin: guard });
  }
  return out("open", "funded", { ...base, margin: guard, intent: openIntent(best, byToken.get(best.token), params) });
}

// Сторож залога для КАНДИДАТА на вход. Гипотетическая позиция стоит по текущей цене, поэтому цена
// входа и марка у неё совпадают, и запас равен полному ходу до ликвидации. Цена и предельное плечо
// биржи берутся у РЫНКА, а не у кривой: кривая это ответ правила размера, наблюдений в ней нет.
function entryGuard(curve, market, params) {
  return marginGuard({
    legs: positionLegs({
      strategy: curve.strategy || market?.strategy || "two", config: curve.config, sizeUsd: curve.sizeUsd,
      leverage: params.leverage, entryPx: market?.markPx, markPx: market?.markPx, hlMaxLev: market?.hlMaxLev,
    }),
    minRoomFraction: params.minRoomFraction,
  });
}

// НАМЕРЕНИЯ. Ровно то, что нужно исполнителю, и ни поля больше: `want` это заявленный капитал,
// `got` это узел сетки, на который правило легло на самом деле. Одно число из этих двух не
// восстанавливает второе, и в паспорте сделки пишутся оба.
function openIntent(curve, market, params) {
  return {
    action: "open", token: curve.token, config: curve.config, strategy: market?.strategy || "two",
    wantUsd: params.capitalUsd, gotUsd: curve.sizeUsd, leverage: params.leverage,
    markPx: market?.markPx ?? null, hlMaxLev: market?.hlMaxLev ?? null,
    netUsd: curve.netUsd, costUsd: curve.costUsd, binding: curve.binding,
  };
}
function closeIntent(position, why) {
  return { action: "close", id: position.id, token: position.token, config: position.config, strategy: position.strategy, why };
}
function switchIntent(position, curve, market, params, why) {
  return { ...openIntent(curve, market, params), action: "switch", closeId: position.id, closeToken: position.token, why };
}

// ─────────────────────────────────────────────────────────────────────────────
// ЖУРНАЛ. Одна строка на тик, образец `explainSize` и `explainExit`. Существует потому, что тик,
// которого нельзя объяснить оператору, неотличим от произвольного бездействия.
// ─────────────────────────────────────────────────────────────────────────────
export function explainAuto(tick) {
  if (!tick) return "тика нет";
  // Код БЕЗ русского текста печатается ОДИН раз, а не дважды. Своей таблицы на чужие коды у
  // автомата нет намеренно: перевод кодов правил живёт в их собственных модулях, и копия здесь
  // разошлась бы с оригиналом на первой правке.
  const text = REFUSAL_TEXT[tick.why];
  const why = text ? `${text} (${tick.why})` : tick.why;
  if (tick.kind === "open") {
    const i = tick.intent;
    return `ВХОД ${i.token}/${i.config} $${i.gotUsd.toFixed(0)} из заявленных $${i.wantUsd.toFixed(0)}, нетто $${i.netUsd.toFixed(2)} (${tick.why})`;
  }
  if (tick.kind === "close") return `ВЫХОД ${tick.intent.token}: ${why}`;
  if (tick.kind === "switch") {
    const i = tick.intent;
    return `ПЕРЕКЛАДКА ${i.closeToken} в ${i.token}/${i.config} $${i.gotUsd.toFixed(0)}: ${why}`;
  }
  const hidden = [...new Set((tick.refusals || []).map((r) => r.code))].filter((c) => c !== tick.why);
  return `без действия: ${why}${hidden.length ? `; тише этого: ${hidden.join(", ")}` : ""}`;
}
