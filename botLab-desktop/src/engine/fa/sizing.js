// sizing.js - ПРАВИЛО РАЗМЕРА ВХОДА БОТА 1. PURE: ни сети, ни файлов, ни Date.now.
//
// ЧТО ЗДЕСЬ РЕШАЕТСЯ. Сколько долларов ставить на КАЖДЫЙ рынок и какие рынки финансировать вовсе.
// Не «сколько у нас денег»: капитал это РЕЗУЛЬТАТ расчёта, а не вход. Оптимальный размер задаётся
// экономикой самого рынка, а потолок капитала работает не как желание оператора, а как
// единственный работающий регуляризатор: без него честная пер-рыночная оптимизация занимает
// $5.02 млн и приносит МИНУС $232 553 в год (замер, прогон 7).
//
// ОТКУДА БЕРЁТСЯ ВНУТРЕННИЙ ОПТИМУМ. Доход от размера растёт как `S * B/(B+S)`, то есть насыщается
// на котле рынка (правило разбавления, `fa/dilution.js`), а издержки растут линейно плюс
// проскальзывание примерно как X^0.64. Вогнутое минус выпуклое даёт единственный максимум по
// размеру, и ищется он ЧИСЛЕННО: аналитического выражения у него нет, потому что кривая
// проскальзывания задана узлами измерения, а не формулой.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ВЕТКА В auto.js. Если примитивы разбавления живут в одном файле, а
// решение о размере в другом, то размер решают ДВЕ части системы, и они разъезжаются при первой
// правке. Класс дефекта «две части решают одну задачу разными правилами» проект ловил уже
// четырежды. Поэтому арифметики размера нет больше нигде: и живой тракт, и офлайн-прогон, и
// прогоны исследования зовут функции отсюда.
//
// ЧЕГО МОДУЛЬ НЕ ИМПОРТИРУЕТ И ПОЧЕМУ. Ничего из `src/engine/btcopt/`. Замыкания импортов бота 1 и
// бота 2 сегодня пересекаются по ПУСТОМУ множеству, у бота 2 идёт живой прогон, и удобная функция
// оттуда стоила бы этой изоляции. Понадобилась величина от бота 2 - считать у себя: это
// единственный случай, когда дублирование предпочтительнее вызова.
//
// ГЛАВНАЯ ЧЕСТНАЯ ОГОВОРКА, БЕЗ КОТОРОЙ ЧИСЛА НЕЛЬЗЯ УПОТРЕБЛЯТЬ. Правило считает ОЦЕНКУ дохода на
// горизонте, а не доходность. Порог заказчика $25-30 тыс в год не достигается ни на каком капитале:
// максимум честной кривой полного периметра $22 705 при $300k, а на строгом периметре (только нога
// GMX) $2 673. И 79-111% валового дохода полного периметра приходит из НЕРАЗБАВЛЯЕМОЙ ноги
// Hyperliquid, то есть это керри перпа HL с хеджем на GMX, а не арбитраж фандинга GMX.

import { DEFAULT_COSTS, normalizeCosts, roundTripCost } from "../costs.js";
import { openPosition, accrueFromRows, closePosition, positionSummary, legModel } from "../paper.js";

const HOUR_MS = 3600 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// НАСТРОЙКИ. У каждого числа стоит происхождение, и слово ДОПУЩЕНИЕ значит ровно то, что значит:
// величина НЕ замерена и её уточнение это отдельная работа.
// ─────────────────────────────────────────────────────────────────────────────

export const FA_SIZING_DEFAULTS = Object.freeze({
  // ВСЕЛЕННАЯ ЗАМЕРОВ НЕ СОДЕРЖИТ НИ ОДНОГО УМЕРШЕГО РЫНКА, и это смещает ВСЕ числа проекта разом.
  // Проверено 2026-08-31: все 94 ряда кэша ставок обрываются ОДНОЙ датой 2026-06-20, из 31 имени,
  // не вошедшего в замеры, все 30 с данными это ПОЗДНИЕ ЛИСТИНГИ (первый час позже начала года),
  // умерших нет ни одного. Причина в сборе: кэш снят по рынкам, существовавшим на момент выгрузки,
  // поэтому делистнутый рынок в него не попал бы вовсе, и его вклад из этих данных НЕИЗМЕРИМ.
  // Вдобавок у выброшенных имён ставки в хвосте КРУПНЕЕ (медиана p90 почасовой ставки получателя
  // 303.3% годовых против 125.3% в выборке), то есть смещение ДВОЯКОЕ, а не односторонне
  // безопасное. Любое число, посчитанное на этой вселенной, надо читать как оценку сверху по
  // выживаемости и снизу по доступности имён.

  // ЗАМЕР. Ответ целиком определяется горизонтом: на живом срезе H = 8 ч и 24 ч дают 0 рынков,
  // 168 ч дают 4 рынка, 720 ч дают 20 рынков, 8760 ч дают 22. Вне выборки при окнах удержания
  // 30 суток пер-рыночный размер лучше единого на всех капиталах; при 90 сутках на малом капитале
  // уже хуже ($629 против $1124 при $10k); при 270 сутках отрицателен всюду. 720 часов это
  // единственный горизонт, на котором правило измерено и не проигрывает базе.
  horizonH: 720,

  // ЗАМЕР цены потолка: `S <= B` снимает 14% головного числа ($20 831 против $24 297 при $100k).
  // Без него S*/B доходит до 367% (BERA), 193% (FET), 167% (RENDER), то есть оптимизатор
  // предлагает СТАТЬ РЫНКОМ.
  maxDilutionFraction: 0.5,

  // О6, строгий режим. Выключен в боевом: замер обоих режимов при $200k дал единому размеру
  // -$11 251, пер-рыночному $12 384, то есть выигрыш качественно сохраняется, но сжимается в
  // 2.7 раза.
  flipGuard: false,

  // Доходом считать только ногу GMX (фандинг минус борроу). Это не экзотика, а обязательный режим
  // ОТЧЁТНОСТИ: заказчик спрашивал буквально про арбитраж фандинга GMX, а полный периметр отвечает
  // на другой вопрос.
  gmxOnlyPerimeter: false,

  // О3. ЗАМЕР: узлы кривой стакана [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000],
  // дальше измерений нет. 69% безлимитного оптимума ($92 195 из $133 835) добывалось за краем, где
  // кривая достроена степенью, а у BTC она вообще постоянна на всех восьми узлах.
  allowExtrapolation: false,
  hlLastMeasuredNodeUsd: 500000,

  // ДОПУЩЕНИЕ. Обоснование: gmxGas $1 плоский, на $500 это 20 базисных пунктов, сопоставимо со
  // всем кругом торговых издержек. Сеткой по minTicket никто не гонял.
  minTicketUsd: 500,

  // ПОТОЛОК ТИКЕТА. ЭТО ДОПУЩЕНИЕ, А НЕ ЗАМЕР: значение $5000 подбиралось на ТЕХ ЖЕ данных, на
  // которых мерилось, вложенного отбора (параметр по блокам до t, применение к t+1) оно не
  // проходило. Что установлено твёрдо: операнд это МАСШТАБ ТИКЕТА, а не форма размера. Без потолка
  // пер-рыночный argmax проигрывает единому размеру (перестановочный тест p = 0.0121) при
  // медианном тикете $10 000 на первом годе и $89 717 на втором, и потери идут по статьям,
  // линейным в ноционале: собственная уплата, борроу, круг издержек. С потолком $5000 пер-рыночный
  // выигрывает в 10 клетках из 10 обоих лет (год 1 при $100k $6565 против $3989).
  ticketCapUsd: 5000,

  // Запас отбора рынка. ЗАМЕР назначения: отношение `maxNet / roundTripCost(S)` выше нуля проходят
  // 44 рынка из 63, выше одного круга 27, выше двух 13; ВНЕ ВЫБОРКИ (непересекающиеся блоки 720 ч,
  // размер лучший на предыдущем блоке) соответственно 26, 17 и 8. Медиана отношения вне выборки
  // МИНУС 0.30 против плюс 0.56 задним числом, то есть типичный рынок, размеченный честно, теряет
  // около трети круга на решение. 27 из 63 это число ЗАДНИМ ЧИСЛОМ, ожидать надо 17.
  //
  // ФОРМА ПОРОГА. Стоимость решения НЕ константа: `roundTripCost` равен `ноционал * 0.31% + $1`,
  // то есть $2.55 при $500, $7.20 при $2000 и $32.00 при $10 000. Сравнивать максимум нетто с одним
  // долларовым порогом нельзя, сравнивать надо с кругом ПРИ ЕГО СОБСТВЕННОМ размере, и безразмерное
  // отношение и есть та величина, которой назначается порог. Условие `нетто > круг` тождественно
  // условию `брутто > два круга`, потому что нетто это брутто минус круг.
  fundRatioK: 1,

  // ЗАМЕР: на плотной сетке 241 узел (шаг 10^0.025) рынков со вторым локальным максимумом НИЖЕ
  // потолка ёмкости ноль из 63. Сетка 61 узел плюс золотое сечение в скобке безопасна.
  gridMinUsd: 10,
  gridMaxUsd: 1e7,
  gridStepLog10: 0.1,
  goldenIters: 30, // ДОПУЩЕНИЕ (запас): сжимает скобку 0.1 декады до 1e-8 декады

  // СЖАТИЕ К ЕДИНОМУ РАЗМЕРУ, `S = S*^(1-w) * S_единый^w`. НЕ ИЗМЕРЕНО и по умолчанию ВЫКЛЮЧЕНО.
  // По прогонам w около 0.5 лучшее в 31 клетке из 40 против 8 у единого и 1 у чистого
  // пер-рыночного, но и w, и потолок тикета подобраны внутри выборки: доказательство лежит в
  // согласии знака (8 фаз-годов из 8) и в счёте клеток, а не в статистике (лучший одиночный
  // t = 1.58, поблочное стандартное отклонение у сжатия в 8-20 раз выше, чем у единого размера).
  // Параметр заведён, чтобы включение не требовало переделки: обе конструкции требуют одного и
  // того же входа S*.
  shrinkToUniform: 0,

  // ЗАМЕР: дрейф живого потока за 240 с медиана 0.11%; сверка со снимком возрастом 21 с даёт 0.38%,
  // со снимком возрастом 37.6 мин уже до 14.71%.
  baseMaxAgeSec: 120,
  // ЗАМЕР: собственный возраст стакана HL медиана 544 мс, максимум 804 мс. 30 с это запас в 37 раз.
  bookMaxAgeSec: 30,
});

// ─────────────────────────────────────────────────────────────────────────────
// РЕЕСТРЫ КОДОВ. Молчаливый пропуск запрещён: каждый исход называется, едет в журнал решения и
// обязан быть виден в интерфейсе.
// ─────────────────────────────────────────────────────────────────────────────

// Рынок НЕ финансируется. Каждый код обязан быть достижим, и это проверяется тестом, а не обещанием.
export const FA_SIZING_REFUSALS = Object.freeze([
  "no_capital_cap", // потолок капитала не конечен: размеров не возвращается вовсе
  "horizon_missing", // горизонт удержания не назван
  "src_gmx_down", // markets/info недоступен: размер не считается НИ НА ОДНОМ рынке
  "src_hl_down", // metaAndAssetCtxs недоступен: то же для двуногих схем
  "no_base", // базы фандинга на рынке нет
  "stale_base", // база старее baseMaxAgeSec, и переносить её с прошлого тика запрещено
  "base_identity_broken", // тождество не сошлось: база пришла НЕ ТА
  "no_book", // стакана HL нет: проскальзывание неизвестно, а константа это выдуманные издержки
  "stale_book", // стакан старее bookMaxAgeSec
  "no_funding", // ставка нашей стороны тождественно ноль: ОТСУТСТВИЕ ПРЕДМЕТА, а не плохие данные
  "no_room", // места меньше минимального билета
  "below_min_ticket", // оптимум есть, но он ниже билета, которым мы умеем войти
  "decreasing_at_every_size", // нетто убывает по размеру ВСЮДУ: настоящий максимум ниже края сетки
  "negative_at_every_size", // на всей сетке нетто отрицательно. НОРМАЛЬНЫЙ исход, а не ошибка
  "below_fund_ratio", // нетто не окупает круг с запасом k
  "no_capital_left", // капитал кончился на других рынках
]);

// Какое ограничение СВЯЗАЛО размер. Это не отказ: рынок профинансирован, но упёрся.
//
// ОТЛИЧИЕ ОТ СПЕЦИФИКАЦИИ, НАЗВАННОЕ ЯВНО. Спецификация держала `extrapolation_blocked` в списке
// отказов, хотя сама же описывала его как обрезку размера («размер обрезается до узла, факт обрезки
// называется»). Код, который никогда не отказывает, но лежит в реестре отказов, делает проверку
// полноты реестра лживой: она требует достижимости того, чего не бывает. Поэтому реестра два.
export const FA_SIZING_BINDINGS = Object.freeze([
  "gmx", // свободная ликвидность рынка GMX нашей стороны
  "book", // видимый объём стакана Hyperliquid
  "exhausted", // уровень, с которого стакан кончается
  "dilution", // О2: потолок разбавления по взвешенной потоком базе
  "extrapolation_blocked", // О3: последний ИЗМЕРЕННЫЙ узел кривой стакана
  "flip", // О6: наш вход не имеет права сделать нашу сторону большей
  "ticket_cap", // потолок тикета T
  "grid", // верхний край сетки поиска
  "capital", // распределитель не смог выдать больше
  null, // ничего не связывает: оптимум внутренний
]);

// ─────────────────────────────────────────────────────────────────────────────
// ПРИМИТИВЫ. Каждый юнит-тестируется отдельно от правила: правило, проверяемое только целиком,
// нельзя разобрать по причине отказа.
// ─────────────────────────────────────────────────────────────────────────────

// О2: при каком размере наш вход опустит котируемую ставку ровно в долю d.
// `S <= B * d / (1-d)`; при d = 0.5 это `S <= B`.
export function sizeCeiling(bUsd, maxDilutionFraction) {
  const d = Number(maxDilutionFraction);
  if (!Number.isFinite(bUsd) || bUsd <= 0) return 0;
  if (!Number.isFinite(d) || d <= 0) return 0;
  if (d >= 1) return Infinity; // разбавление не ограничено вовсе
  return (bUsd * d) / (1 - d);
}

// О2 берёт базу, ВЗВЕШЕННУЮ ПОТОКОМ ПОЛУЧЕНИЯ, а не квантиль и не базу на входе.
//
// ЗАЧЕМ. Доход считается почасово, с почасовой базой, поэтому хвост распределения он учитывает
// верно. А ограничение оценивается ОДНИМ числом в момент решения, и одно число из центра
// распределения разрешает размер во много раз больший того, при котором удержание уже упало: у BERA
// медианная база $6.8 тыс, то есть О2 при d = 0.5 пропустит вход в $6800, тогда как удержание там
// ниже половины уже при входе в ОДИН доллар. Разрыв в тысячи раз, и берётся он из ФОРМЫ
// распределения, а не из величины медианы.
//
// ПОЧЕМУ НЕ КВАНТИЛЬ. Направление расхождения НЕ универсально, и это решает дело. Отношение
// взвешенной базы к медиане: ANIME 0.31, BERA 0.04, BONK 1.04, EIGEN 0.60, FET 0.16, INJ 0.22, но
// BTC 1.24, ETH 1.41, SOL 1.99, LINK 1.91. У мажоров деньги приходят в часы с БОЛЬШЕЙ базой, то
// есть фиксированный p25 давил бы их без нужды и всё равно не спасал бы на тесных именах.
// Взвешенная потоком база отвечает ровно на тот вопрос, который определяет удержание: какая база в
// тех часах, откуда приходят деньги, и потому она права в обе стороны.
//
// ЧАСЫ УПЛАТЫ В СЧЁТ НЕ ВХОДЯТ: разбавление их не трогает вовсе (правило 3), и множителя там нет.
export function flowWeightedBase(rows, gmxSide) {
  let wSum = 0;
  let fSum = 0;
  let hours = 0;
  for (const r of rows || []) {
    const f = gmxSide === "short" ? r.f_short : r.f_long;
    const b = gmxSide === "short" ? r.fbase_short : r.fbase_long;
    if (!(f > 0) || !(b > 0)) continue;
    wSum += f * b;
    fSum += f;
    hours += 1;
  }
  return { usd: fSum > 0 ? wSum / fSum : NaN, hours, flowSum: fSum };
}

// Ставка нашей стороны тождественно ноль на всём окне значит ОТСУТСТВИЕ ПРЕДМЕТА.
//
// Рынок с нулевой ставкой не даёт стратегии ничего, кроме борроу и круга издержек. Замер:
// у AAVE, ATOM, AVAX, NEAR и OP индексатор даёт 168 снимков из 168 с РОВНО нулевой ставкой в окне
// внутри 2023-09..2025-06, а у BTC и LINK 168 из 168 ненулевых там же; кэш ставок, собранный
// раньше и сторонним проектом, согласен с индексатором. Фандинга на этих рынках тогда просто не
// было: GMX включал его по рынкам.
//
// ПРАВИЛО, А НЕ СПИСОК ИМЁН, И ЭТО ПРИНЦИПИАЛЬНО. Шесть имён это свойство ПЕРИОДА, а не рынка: в
// году 2025-06..2026-06 у тех же AAVE, AVAX и TAO фандинг есть, они входят в 28 «чистых» имён
// прогона разбавления. Зашитый список тикеров запретил бы рынки, на которых фандинг работает,
// то есть был бы неверен ровно там, где правило исполняется.
export function hasFunding(rows, gmxSide) {
  for (const r of rows || []) {
    const f = gmxSide === "short" ? r.f_short : r.f_long;
    if (Number.isFinite(f) && f !== 0) return true;
  }
  return false;
}

// О1: сколько места на рынке. Возвращает и число, и ИМЯ связывающего ограничения: без имени
// оператор не может отличить «рынок мал» от «стакан тонок», а это разные решения.
export function roomCeiling({ gmxAvailOwnUsd, hlVisibleNtl, hlExhaustedFrom } = {}) {
  const cands = [
    { binding: "gmx", usd: gmxAvailOwnUsd },
    { binding: "book", usd: hlVisibleNtl },
    { binding: "exhausted", usd: hlExhaustedFrom },
  ].filter((c) => Number.isFinite(c.usd) && c.usd >= 0);
  if (!cands.length) return { usd: Infinity, binding: null };
  let best = cands[0];
  for (const c of cands) if (c.usd < best.usd) best = c;
  return { usd: best.usd, binding: best.binding };
}

// Логарифмическая сетка размеров. Верхний край ВКЛЮЧАЕТСЯ отдельным узлом: у рынков вроде BERA
// оптимум упирается в потолок ёмкости, и без узла ровно на потолке правило вернуло бы размер ниже
// доступного просто потому, что сетка туда не попала.
//
// ДВА СЛЕДСТВИЯ СЕТКИ, НА КОТОРЫХ ТЕРЯЮТСЯ ДЕНЬГИ. Оба замерены 2026-08-31 и оба не видны из кода
// без этого блока, потому что сама сетка выглядит безобидно.
//
// 1. ЖЁСТКИЙ ПОЛ $501.19, А НЕ $500. Шаг сетки 0.1 декады, поэтому узлов между $398.11 и $501.19
//    нет вовсе, а `minTicketUsd` отсекает всё ниже $500. Значит первый ДОСТИЖИМЫЙ размер это
//    $501.19, и при капитале ровно $500 не открывается НИЧЕГО: замер даёт ноль позиций в сорока
//    стартах. Это не «мало заработает», это «не запустится», и оператору надо говорить $501, а не
//    $500.
//
// 2. КАПИТАЛ МЕЖДУ УЗЛАМИ ПРОСТАИВАЕТ. Соседние достижимые размеры отличаются на 26%, а
//    распределитель ходит по оболочке, построенной на этих же узлах, поэтому заявленный капитал
//    округляется ВНИЗ до узла. Замер: капитал $2500 даёт фактический размер $1995.26 во ВСЕХ
//    решениях, то есть 20.2% не работает; $2515 даёт $2511.89 и на 10.6% больше денег ни за что;
//    $3200 даёт $875.02 против $706.78. Уровни $2100, $2300, $2500 и $2511 неразличимы между собой
//    и все дают $1995.26.
//
//    Отсюда правило для интерфейса и для оператора: заявленный капитал и ФАКТИЧЕСКИ размещённый
//    это разные числа, и показывать надо оба. Круглое число вроде $2500 стоит в худшем углу
//    ступени чаще, чем в лучшем.
export function logGrid(minUsd, maxUsd, stepLog10) {
  const lo = Math.log10(minUsd);
  const hi = Math.log10(maxUsd);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return [];
  const step = Number.isFinite(stepLog10) && stepLog10 > 0 ? stepLog10 : 0.1;
  const out = [];
  for (let e = lo; e < hi - 1e-12; e += step) out.push(10 ** e);
  out.push(maxUsd);
  return out;
}

// Кусочно-линейная интерполяция базисных пунктов по log10(размера) между УЗЛАМИ ИЗМЕРЕНИЯ.
// За краями держится крайний узел, а не степенная достройка: достройка это и есть та зона, где
// добывались 69% фантомного оптимума. Узлы ПЕРЕДАЮТСЯ, модуль их не читает и не хранит.
export function interpBps(nodes, sizeUsd) {
  const pts = (nodes || []).filter((n) => Number.isFinite(n.sizeUsd) && n.sizeUsd > 0 && Number.isFinite(n.bps));
  if (!pts.length) return NaN;
  const s = [...pts].sort((a, b) => a.sizeUsd - b.sizeUsd);
  if (!(sizeUsd > 0)) return s[0].bps;
  if (sizeUsd <= s[0].sizeUsd) return s[0].bps;
  if (sizeUsd >= s[s.length - 1].sizeUsd) return s[s.length - 1].bps;
  for (let i = 1; i < s.length; i += 1) {
    if (sizeUsd <= s[i].sizeUsd) {
      const x0 = Math.log10(s[i - 1].sizeUsd);
      const x1 = Math.log10(s[i].sizeUsd);
      const t = x1 === x0 ? 0 : (Math.log10(sizeUsd) - x0) / (x1 - x0);
      return s[i - 1].bps + t * (s[i].bps - s[i - 1].bps);
    }
  }
  return s[s.length - 1].bps;
}

// ВОГНУТАЯ ОБОЛОЧКА кривой нетто по размеру, от точки (0, 0).
//
// ЗАЧЕМ ОНА НУЖНА РАСПРЕДЕЛИТЕЛЮ. Задача с одним ресурсом и вогнутой отдачей решается жадным
// отбором по отдаче на доллар, но `net(S)` НЕ вогнута: выпуклые участки есть у 59 рынков из 63,
// медиана 95 узлов. Жадность по сырым узлам на выпуклом участке выбирает шаг с меньшей отдачей и
// застревает. Оболочка оставляет только те шаги, у которых отдача на доллар УБЫВАЕТ, и жадность
// на ней корректна.
//
// Точки ниже минимального билета в оболочку не входят: рынок либо не финансируется, либо получает
// не меньше билета, и промежуточных состояний у него нет. Так потолок билета встроен в саму
// структуру шага, а не чинится потом циклом «выбросить и раздать заново».
export function concaveHull(points, minTicketUsd = 0) {
  const src = (points || [])
    .filter((p) => Number.isFinite(p.sizeUsd) && p.sizeUsd >= minTicketUsd && Number.isFinite(p.net))
    .sort((a, b) => a.sizeUsd - b.sizeUsd);
  const hull = [{ sizeUsd: 0, net: 0 }];
  for (const p of src) {
    // Пока новый шаг даёт отдачу на доллар БОЛЬШЕ предыдущего, предыдущий лежит под хордой и на
    // оболочке ему не место.
    for (;;) {
      const last = hull[hull.length - 1];
      const prev = hull[hull.length - 2];
      if (!prev) break;
      const slopeNew = (p.net - prev.net) / (p.sizeUsd - prev.sizeUsd);
      const slopeOld = (last.net - prev.net) / (last.sizeUsd - prev.sizeUsd);
      if (slopeNew > slopeOld) hull.pop();
      else break;
    }
    const last = hull[hull.length - 1];
    if (p.sizeUsd > last.sizeUsd) hull.push({ sizeUsd: p.sizeUsd, net: p.net });
  }
  return hull;
}

// ПРОХОДКА ПО СТАКАНУ: сколько базисных пунктов стоит пройти размер S по уровням.
//
// ЖИВЬЁМ КРИВОЙ ПРОСКАЛЬЗЫВАНИЯ НЕ СУЩЕСТВУЕТ, её надо построить из стакана, и делается это ровно
// здесь. Офлайн-прогон читает уже посчитанную таблицу, живой тракт считает из свежего стакана, и
// если бы у них были две реализации проходки, они разъехались бы при первой правке.
//
// ГРУБЫЕ КНИГИ ЗАПРЕЩЕНЫ, и это замер, а не осторожность: агрегация уровней (`nSigFigs`) округляет
// цену верхнего уровня, и проходка даёт мусор. У ETH при `nSigFigs = 3` получалось 20.28 базисного
// пункта против 0.20 на полной точности, то есть в сто раз больше. Уровни обязаны приходить без
// агрегации.
//
// Возвращает NaN, когда стакана НЕ ХВАТАЕТ на такой размер: это не ноль и не «дорого», это
// «неизвестно», и подставить сюда число значило бы выдумать издержку.
export function bookFillBps(levels, midPx, sizeUsd) {
  if (!Array.isArray(levels) || !(midPx > 0) || !(sizeUsd > 0)) return NaN;
  let need = sizeUsd;
  let spent = 0;
  let got = 0;
  for (const l of levels) {
    const px = Number(l.px);
    const sz = Number(l.sz);
    if (!(px > 0) || !(sz > 0)) continue;
    const take = Math.min(need, px * sz);
    spent += take;
    got += take / px;
    need -= take;
    if (need <= 1e-9) break;
  }
  if (need > 1e-9 || !(got > 0)) return NaN; // стакан кончился раньше размера
  return (Math.abs(spent / got - midPx) / midPx) * 1e4;
}

// Кривая проскальзывания КРУГА (вход плюс выход) и ёмкость стакана из живой выдачи `l2Book`.
// Круг одинаков в обеих конфигурациях: одна покупает на входе и продаёт на выходе, вторая наоборот.
export function bookSlippageNodes({ bids, asks, nodesUsd }) {
  const bestBid = Number(bids?.[0]?.px);
  const bestAsk = Number(asks?.[0]?.px);
  if (!(bestBid > 0) || !(bestAsk > 0)) return { nodes: [], visibleNtl: 0, exhaustedFrom: 0 };
  const mid = (bestBid + bestAsk) / 2;
  const ntl = (side) => (side || []).reduce((s, l) => s + Number(l.px) * Number(l.sz), 0);
  const visibleNtl = Math.min(ntl(bids), ntl(asks));
  const nodes = [];
  let exhaustedFrom = Infinity;
  for (const x of nodesUsd || []) {
    const buy = bookFillBps(asks, mid, x);
    const sell = bookFillBps(bids, mid, x);
    if (!Number.isFinite(buy) || !Number.isFinite(sell)) { exhaustedFrom = Math.min(exhaustedFrom, x); break; }
    nodes.push({ sizeUsd: x, bps: buy + sell });
  }
  return { nodes, visibleNtl, exhaustedFrom: Number.isFinite(exhaustedFrom) ? exhaustedFrom : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// ИЗДЕРЖКИ И НЕТТО
// ─────────────────────────────────────────────────────────────────────────────

// Круг издержек при размере. Плоские 0.1% ценового удара движка ЗАМЕНЯЮТСЯ измеренной кривой,
// когда она передана: сама измеренная величина в рабочем диапазоне 0.1-1.2 базисного пункта за
// круг и от размера почти не зависит, и замена двигает базовый оптимум с $3162/$9507 на
// $3057/$9574, то есть на доли процента. Держать её всё равно надо: без неё правило считает
// издержки, которых не мерило.
//
// `impact` это ДАННЫЕ, а не файлы: `{ gmxNodes, hlNodes }`, где `bps` уже приведены к ИЗДЕРЖКЕ
// (неотрицательное число). Знак первоисточника (у GMX `adverseBps` отрицателен, когда платит
// трейдер) приводится тем, кто читает файл, и это названо здесь, чтобы приведение не случилось
// дважды.
export function costAtSize({ sizeUsd, costs = DEFAULT_COSTS, impact = null, isOneLeg = false }) {
  if (!Number.isFinite(sizeUsd) || sizeUsd < 0) return NaN;
  const c = normalizeCosts(costs);
  const hasGmxCurve = impact && Array.isArray(impact.gmxNodes) && impact.gmxNodes.length > 0;
  const base = roundTripCost(hasGmxCurve ? { ...c, gmxImpact: 0 } : c, sizeUsd, isOneLeg);
  let extraBps = 0;
  if (hasGmxCurve) {
    const b = interpBps(impact.gmxNodes, sizeUsd);
    if (Number.isFinite(b)) extraBps += Math.max(0, b);
  }
  if (!isOneLeg && impact && Array.isArray(impact.hlNodes) && impact.hlNodes.length) {
    const b = interpBps(impact.hlNodes, sizeUsd);
    if (Number.isFinite(b)) extraBps += Math.max(0, b);
  }
  return base + (sizeUsd * extraBps) / 1e4;
}

// Нетто на горизонте при размере S. Начисление считает ДВИЖОК (`paper.js` с флагом `dilute`), а не
// этот модуль: своей арифметики начисления здесь нет ни строки, иначе правило имело бы вторую
// реализацию и доказывало бы само себя.
//
// РАЗБОР НОГ БЕРЁТСЯ ИЗ ЖУРНАЛА НАЧИСЛЕНИЯ, а не пересчитывается: `fundingUsd` и `borrowUsd` уже
// записаны леджером по часам, и сложить их заново значит получить другой последний бит.
export function netAtSize({ rows, config, strategy = "two", sizeUsd, costs = DEFAULT_COSTS, impact = null, cfg = FA_SIZING_DEFAULTS, token = null }) {
  if (!rows || !rows.length || !(sizeUsd > 0)) return null;
  const isOneLeg = strategy === "one";
  const cost = costAtSize({ sizeUsd, costs, impact, isOneLeg });
  const t0 = rows[0].tsHour * 1000;
  const tEnd = rows[rows.length - 1].tsHour * 1000 + HOUR_MS;
  const p = openPosition({
    strategy, instrumentKey: token || "?", config: isOneLeg ? null : config,
    capital: sizeUsd, leverage: 1, nowMs: t0, roundTripCost: cost, dilute: true,
  });
  accrueFromRows(p, rows, tEnd);
  closePosition(p, tEnd);
  const s = positionSummary(p);
  let gmxFundingUsd = 0;
  let gmxBorrowUsd = 0;
  let hlUsd = 0;
  for (const a of p.accruals) {
    gmxFundingUsd += a.fundingUsd ?? 0;
    gmxBorrowUsd += a.borrowUsd ?? 0;
    hlUsd += a.dPnlHl ?? 0;
  }
  // СТРОГИЙ ПЕРИМЕТР. Если доходом считать только ногу GMX, оптимизатор выбирает ДРУГОЙ портфель и
  // зарабатывает на GMX больше, чем портфель полного периметра ($36 998 против $33 778 при $200k).
  // То есть портфель полного периметра проигрывает на самой цели исследования, и режим обязан быть
  // достижим, а не считаться экзотикой.
  const gross = cfg.gmxOnlyPerimeter ? gmxFundingUsd + gmxBorrowUsd : s.grossPnl;
  return {
    sizeUsd,
    net: gross - cost,
    gross,
    cost,
    parts: { gmxFundingUsd, gmxBorrowUsd, hlUsd },
    flowQuoted: s.flowQuoted,
    flowReceived: s.flowReceived,
    dilutionRetained: s.dilutionRetained,
    noBaseSec: s.noBaseSec,
    badBaseSec: s.badBaseSec,
    hoursApplied: p.accruals.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ПРАВИЛО ПО ОДНОМУ РЫНКУ
// ─────────────────────────────────────────────────────────────────────────────

const refuse = (token, config, code, extra = {}) => ({
  token, config, sizeUsd: null, starUsd: null, netUsd: null, grossUsd: null, costUsd: null,
  ratio: null, ratioAtStar: null, ceilingUsd: null, binding: null, hull: [], points: [],
  refusal: code, ...extra,
});

// Ворота данных. Отказ базы и отказ стакана это РАЗНЫЕ причины, и сливать их в одну нельзя:
// первая означает «разбавление посчитать нечем», вторая «издержки посчитать нечем», и лечатся они
// в разных местах.
function dataGate(live, cfg) {
  if (!live) return "no_base";
  if (live.gmxDown) return "src_gmx_down";
  if (live.hlDown) return "src_hl_down";
  if (!Number.isFinite(live.bOwnUsd) || live.bOwnUsd <= 0) return "no_base";
  if (Number.isFinite(live.baseAgeSec) && live.baseAgeSec > cfg.baseMaxAgeSec) return "stale_base";
  if (live.baseIdentityOk === false) return "base_identity_broken";
  if (live.bookMissing) return "no_book";
  if (Number.isFinite(live.bookAgeSec) && live.bookAgeSec > cfg.bookMaxAgeSec) return "stale_book";
  return null;
}

// Все потолки размера в одном месте, с именем СВЯЗЫВАЮЩЕГО.
function ceilingsFor({ live, weightedBaseUsd, cfg }) {
  const room = roomCeiling(live);
  const cands = [
    { binding: room.binding, usd: room.usd }, // О1
    { binding: "dilution", usd: sizeCeiling(weightedBaseUsd, cfg.maxDilutionFraction) }, // О2
    { binding: "grid", usd: cfg.gridMaxUsd },
  ];
  // О3: за последний ИЗМЕРЕННЫЙ узел кривой стакана не ходить.
  if (!cfg.allowExtrapolation) cands.push({ binding: "extrapolation_blocked", usd: cfg.hlLastMeasuredNodeUsd });
  // О6, строгий режим: наш вход не имеет права сделать нашу сторону БОЛЬШЕЙ.
  //
  // ГРАНИЦА, НАЗВАННАЯ ЯВНО. В замере строгий режим реализован ещё и ОБНУЛЕНИЕМ дохода в те часы,
  // где перевес всё-таки случился; здесь его нет, потому что почасовое обнуление живёт в слое
  // начисления, а трогать леджер ради выключенного по умолчанию режима значит двигать три
  // замороженные книги. Поэтому числа строгого периметра спецификации ($2673 в год) этим модулем
  // НЕ воспроизводятся, и выдавать его за них нельзя.
  if (cfg.flipGuard) {
    const other = Number.isFinite(live.bOtherWeightedUsd) ? live.bOtherWeightedUsd : live.bOtherUsd;
    cands.push({ binding: "flip", usd: Math.max(0, (other ?? 0) - weightedBaseUsd) });
  }
  let best = { binding: null, usd: Infinity };
  for (const c of cands) if (Number.isFinite(c.usd) && c.usd < best.usd) best = c;
  return best;
}

// Золотое сечение по log10(S) в скобке лучшего узла. Ищется МАКСИМУМ, поэтому шаги те же, что у
// поиска минимума с обратным знаком.
function goldenRefine(evalNet, loLog, hiLog, iters) {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = loLog;
  let b = hiLog;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = evalNet(10 ** c);
  let fd = evalNet(10 ** d);
  for (let i = 0; i < iters; i += 1) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = evalNet(10 ** c); }
    else { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = evalNet(10 ** d); }
  }
  return 10 ** ((a + b) / 2);
}

// ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ВЫБИРАЕТСЯ РАЗМЕР НА РЫНКЕ.
//
// ПОРЯДОК ШАГОВ ЗНАЧИМ И КУПЛЕН ОШИБКОЙ. Диагностика края сетки идёт ДО отбора по отношению:
// у класса «нетто убывает по размеру всюду» (19 рынков из 63) настоящий максимум лежит НИЖЕ края
// сетки, а край уже ниже минимального билета, и ДВА таких рынка проходили отбор по числу, которого
// в бою не существует (ANIME: край $3.31 и отношение 2.53, на билете $500 нетто МИНУС $2.66;
// MEME: край $1.40 и 1.07, на билете минус $1.03). Такой рынок обязан получать СВОЙ код отказа, а
// не проходить через формулу отношения.
export function bestSizeForMarket({ token, config, strategy = "two", rows, live, costs = DEFAULT_COSTS, impact = null, cfg = FA_SIZING_DEFAULTS, uniformSizeUsd = null }) {
  const c = { ...FA_SIZING_DEFAULTS, ...cfg };
  if (!Number.isFinite(c.horizonH) || c.horizonH <= 0) return refuse(token, config, "horizon_missing");
  const gate = dataGate(live, c);
  if (gate) return refuse(token, config, gate);
  if (!rows || !rows.length) return refuse(token, config, "no_base");

  const { gmxSide } = legModel(strategy, config);
  // «Ставки нет ни в одном часе» и «ставка везде ровно ноль» это РАЗНЫЕ сообщения, и путать их
  // нельзя: первое означает пропавшие данные, второе означает, что фандинга на рынке не было.
  // Без этой развилки отказ снабжения выглядел бы как отсутствие предмета, то есть как нормальный
  // исход, и молча уводил бы рынок из среза навсегда.
  if (!rows.some((r) => Number.isFinite(gmxSide === "short" ? r.f_short : r.f_long))) {
    return refuse(token, config, "no_base");
  }
  if (!hasFunding(rows, gmxSide)) return refuse(token, config, "no_funding");

  const weighted = flowWeightedBase(rows, gmxSide);
  // Взвешенной базы нет, когда часов получения на окне не было вовсе. Это не поломка данных: рынок
  // весь период платил, и разбавлять там нечего. Отбор такой рынок всё равно не пройдёт, но
  // потолок О2 обязан остаться конечным, иначе оптимизатор пойдёт вверх без ограничения.
  const weightedBaseUsd = Number.isFinite(weighted.usd) ? weighted.usd : live.bOwnUsd;
  const ceil = ceilingsFor({ live, weightedBaseUsd, cfg: c });
  if (!(ceil.usd >= c.minTicketUsd)) {
    return refuse(token, config, "no_room", { ceilingUsd: ceil.usd, binding: ceil.binding, flowWeightedBaseUsd: weightedBaseUsd });
  }

  const evalAt = (sizeUsd) => netAtSize({ rows, config, strategy, sizeUsd, costs, impact, cfg: c, token });
  const grid = logGrid(c.gridMinUsd, Math.min(ceil.usd, c.gridMaxUsd), c.gridStepLog10);
  const points = [];
  for (const s of grid) {
    const r = evalAt(s);
    if (r) points.push({ sizeUsd: s, net: r.net });
  }
  if (!points.length) return refuse(token, config, "no_room", { ceilingUsd: ceil.usd, binding: ceil.binding });

  let bestIdx = 0;
  for (let i = 1; i < points.length; i += 1) if (points[i].net > points[bestIdx].net) bestIdx = i;
  const best = points[bestIdx];
  const common = {
    ceilingUsd: ceil.usd, binding: ceil.binding, flowWeightedBaseUsd: weightedBaseUsd,
    points, hull: [],
  };

  // ПОРЯДОК ЭТИХ ДВУХ ПРОВЕРОК ЗНАЧИМ. Сначала простая правда «ни один размер не окупается»: это
  // НОРМАЛЬНЫЙ исход, а не ошибка, и он информативнее любых рассуждений про сетку. Отдельный код
  // остаётся ровно тому классу, ради которого он и заведён: нетто на нижнем краю ПОЛОЖИТЕЛЬНО и
  // убывает дальше всюду, то есть настоящий максимум лежит НИЖЕ края сетки, а край уже ниже
  // минимального билета. Именно так ANIME (край $3.31, отношение 2.53, на билете $500 нетто минус
  // $2.66) и MEME (край $1.40, отношение 1.07, на билете минус $1.03) проходили отбор по числу,
  // которого в бою не существует.
  if (points.every((p) => p.net <= 0)) {
    return refuse(token, config, "negative_at_every_size", { ...common, starUsd: best.sizeUsd });
  }
  if (bestIdx === 0 && points.length > 1) {
    return refuse(token, config, "decreasing_at_every_size", { ...common, starUsd: best.sizeUsd });
  }

  // Уточнение в скобке лучшего узла. Скобка это соседние узлы, а на краю сетки она односторонняя.
  const loLog = Math.log10(points[Math.max(0, bestIdx - 1)].sizeUsd);
  const hiLog = Math.log10(points[Math.min(points.length - 1, bestIdx + 1)].sizeUsd);
  let starUsd = best.sizeUsd;
  if (hiLog > loLog && c.goldenIters > 0) {
    const refined = goldenRefine((s) => (evalAt(s)?.net ?? -Infinity), loLog, hiLog, c.goldenIters);
    if (Number.isFinite(refined) && (evalAt(refined)?.net ?? -Infinity) > best.net) starUsd = refined;
  }

  // СЖАТИЕ К ЕДИНОМУ РАЗМЕРУ. Геометрическое среднее, а не арифметическое: размеры разбросаны на
  // пять порядков (квантили S* по 59 прибыльным рынкам: min $10, p25 $706, медиана $5052, p75
  // $14 770, max $3.57 млн), и среднее в логарифме это то же самое, что среднее по величине
  // ставки, а не по величине рынка. При w = 0 множитель равен единице ПОБИТОВО.
  const w = Number.isFinite(c.shrinkToUniform) ? Math.min(1, Math.max(0, c.shrinkToUniform)) : 0;
  let sized = starUsd;
  if (w > 0 && Number.isFinite(uniformSizeUsd) && uniformSizeUsd > 0) {
    sized = starUsd ** (1 - w) * uniformSizeUsd ** w;
  }

  // ЧТО СВЯЗАЛО РАЗМЕР. Имя связывающего это не украшение отчёта: «упёрлись в стакан» и «упёрлись в
  // потолок разбавления» лечатся разными решениями, а «оптимум внутренний» не лечится вовсе.
  let binding = starUsd >= ceil.usd - 1e-9 ? ceil.binding : null;

  // ПОТОЛОК ТИКЕТА. Применяется ПОСЛЕ сжатия: сжатие к единому размеру может поднять размер выше T,
  // и тогда потолок обязан связать. Потолки ёмкости идут последними, они строже любого допущения.
  if (Number.isFinite(c.ticketCapUsd) && sized > c.ticketCapUsd) { sized = c.ticketCapUsd; binding = "ticket_cap"; }
  if (sized > ceil.usd) { sized = ceil.usd; binding = ceil.binding; }

  if (sized < c.minTicketUsd) {
    return refuse(token, config, "below_min_ticket", { ...common, starUsd, binding });
  }

  const at = evalAt(sized);
  const atStar = starUsd === sized ? at : evalAt(starUsd);
  const ratio = at.cost > 0 ? at.net / at.cost : NaN;
  const ratioAtStar = atStar && atStar.cost > 0 ? atStar.net / atStar.cost : NaN;

  // ОТБОР РЫНКА. Отношение считается ПРИ ТОРГУЕМОМ размере, а не при S*: решение, которое мы
  // принимаем, звучит «войти размером S или нет», и мерить его экономику на размере, которым мы не
  // войдём, есть ровно тот дефект, из-за которого ANIME и MEME проходили отбор. Отношение при S*
  // возвращается рядом и едет в журнал: оно нужно для РАЗБОРА, а не для решения.
  //
  // ОГОВОРКА, БЕЗ КОТОРОЙ ПОРОГ БУДЕТ ПОНЯТ НЕВЕРНО: k = 1 откалибровано на нецензурированном
  // argmax, то есть порог наследует это допущение.
  if (!(ratio > c.fundRatioK)) {
    return refuse(token, config, "below_fund_ratio", {
      ...common, starUsd, binding, ratio, ratioAtStar,
      netUsd: at.net, grossUsd: at.gross, costUsd: at.cost,
    });
  }

  return {
    token, config, gmxSide,
    sizeUsd: sized,
    starUsd,
    netUsd: at.net,
    grossUsd: at.gross,
    costUsd: at.cost,
    parts: at.parts,
    ratio,
    ratioAtStar,
    ceilingUsd: ceil.usd,
    binding,
    flowWeightedBaseUsd: weightedBaseUsd,
    dilutionRetained: at.dilutionRetained,
    points,
    // ОБОЛОЧКА ОБРЕЗАНА ВЫБРАННЫМ РАЗМЕРОМ, и это не мелочь. Распределитель ходит по ней, и если
    // оставить в ней узлы выше потолка тикета, он выдаст рынку больше, чем разрешило правило,
    // то есть потолок будет соблюдён в одном месте и обойдён в другом. Ровно этот класс дефекта
    // («две части системы решают одну задачу разными правилами») проект ловил четырежды.
    hull: concaveHull([...points.filter((p) => p.sizeUsd < sized), { sizeUsd: sized, net: at.net }], c.minTicketUsd),
    refusal: null,
  };
}

// ЕДИНЫЙ РАЗМЕР: argmax суммы нетто по всем рынкам на общей сетке. Нужен только сжатию.
//
// СМЕЩЕНИЕ СНИМАЕТСЯ ЗДЕСЬ И ЯВНО. Рынки, которым правило отказало, в эту сумму входить не имеют
// права. В прогонах сравнения конструкций отбор «нетто прошлого блока больше нуля» шесть имён с
// нулевой ставкой отсекал, но в выбор ЕДИНОГО размера они входили своими ОТРИЦАТЕЛЬНЫМИ вкладами,
// потому что единый размер это argmax суммы по ВСЕМ рынкам. На отбор они не влияли, а на выбор
// размера влияли, и считать, что фильтр уже всё сделал, нельзя.
export function uniformSizeFor(curves, cfg = FA_SIZING_DEFAULTS) {
  const c = { ...FA_SIZING_DEFAULTS, ...cfg };
  const usable = (curves || []).filter((x) => x && !x.refusal && x.points && x.points.length);
  if (!usable.length) return null;
  // Рынок, чей потолок ниже проверяемого размера, вносит в сумму НОЛЬ, а не свой лучший доступный
  // размер: единый размер на то и единый, что на таком рынке мы просто не торгуем. Это же
  // означает, что сетки рынков не обязаны совпадать хвостами, и совмещать их не надо.
  const sums = new Map();
  for (const cur of usable) {
    for (const p of cur.points) {
      if (p.sizeUsd < c.minTicketUsd) continue;
      const key = p.sizeUsd.toPrecision(12);
      const prev = sums.get(key) || { sizeUsd: p.sizeUsd, net: 0 };
      prev.net += p.net;
      sums.set(key, prev);
    }
  }
  let best = null;
  for (const v of sums.values()) if (!best || v.net > best.net) best = v;
  return best ? best.sizeUsd : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// РАСПРЕДЕЛЕНИЕ КАПИТАЛА
// ─────────────────────────────────────────────────────────────────────────────

// О4. Жадный отбор по ОТДАЧЕ НА ДОЛЛАР вдоль вогнутой оболочки каждого рынка.
//
// БЕЗЛИМИТНЫЙ РЕЖИМ ЗАПРЕЩЁН, и это не удобство сигнатуры: без конечного потолка честная
// пер-рыночная оптимизация занимает $5.02 млн и приносит МИНУС $232 553 в год. Функция обязана
// вернуть ОТКАЗ, а не число.
//
// ПОРЯДОК ОТБОРА ФИКСИРОВАН ПО ИМЕНИ РЫНКА при равных отдачах. Замер: разброс итога по 20 законным
// порядкам отбора составил $19.9 тыс при измеряемом разрыве конструкций $2.4 тыс, то есть
// недетерминированный порядок сам по себе больше того, что мерят.
export function allocateCapital(curves, capitalTotal, cfg = FA_SIZING_DEFAULTS) {
  const c = { ...FA_SIZING_DEFAULTS, ...cfg };
  if (!Number.isFinite(capitalTotal) || capitalTotal <= 0) {
    return { alloc: new Map(), usedUsd: 0, netTotal: 0, refusal: "no_capital_cap" };
  }
  const arms = (curves || [])
    .filter((x) => x && !x.refusal && x.hull && x.hull.length > 1)
    .map((x) => ({ token: x.token, hull: x.hull, at: 0 }))
    .sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  const alloc = new Map();
  let left = capitalTotal;
  for (;;) {
    let pick = null;
    for (const a of arms) {
      const cur = a.hull[a.at];
      const nxt = a.hull[a.at + 1];
      if (!nxt) continue;
      const dS = nxt.sizeUsd - cur.sizeUsd;
      const dNet = nxt.net - cur.net;
      if (!(dS > 0) || !(dNet > 0) || dS > left) continue;
      const slope = dNet / dS;
      if (!pick || slope > pick.slope) pick = { arm: a, slope, dS, nxt };
    }
    if (!pick) break;
    pick.arm.at += 1;
    left -= pick.dS;
    alloc.set(pick.arm.token, pick.nxt.sizeUsd);
  }
  let netTotal = 0;
  for (const a of arms) if (a.at > 0) netTotal += a.hull[a.at].net;
  return { alloc, usedUsd: capitalTotal - left, netTotal, refusal: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// ЕДИНАЯ ТОЧКА ВХОДА
// ─────────────────────────────────────────────────────────────────────────────

// Её зовут и живой тракт, и офлайн-прогон, и прогоны исследования. Отказы НЕ выбрасываются, а
// копятся: рынок, выпавший молча, ничем не отличается от рынка, которого не было.
export function sizeUniverse({ markets, costs = DEFAULT_COSTS, capitalTotal, cfg = FA_SIZING_DEFAULTS, sources = null }) {
  const c = { ...FA_SIZING_DEFAULTS, ...cfg };
  const refusals = [];
  if (!Number.isFinite(c.horizonH) || c.horizonH <= 0) {
    return { alloc: new Map(), usedUsd: 0, netTotal: 0, curves: [], refusals: [{ token: null, refusal: "horizon_missing" }], cfg: c };
  }
  if (!Number.isFinite(capitalTotal) || capitalTotal <= 0) {
    return { alloc: new Map(), usedUsd: 0, netTotal: 0, curves: [], refusals: [{ token: null, refusal: "no_capital_cap" }], cfg: c };
  }
  // ОТКАЗ ИСТОЧНИКА ОСТАНАВЛИВАЕТ ВЕСЬ СРЕЗ, а не отдельный рынок: без `markets/info` неизвестны ни
  // базы, ни место НИ НА ОДНОМ рынке, и считать «по тем, что успели» значит выдать неполный срез за
  // полный. Открытые позиции при этом не трогаются: это правило ВХОДА.
  if (sources && sources.gmxDown) {
    return { alloc: new Map(), usedUsd: 0, netTotal: 0, curves: [], refusals: [{ token: null, refusal: "src_gmx_down" }], cfg: c };
  }
  if (sources && sources.hlDown) {
    return { alloc: new Map(), usedUsd: 0, netTotal: 0, curves: [], refusals: [{ token: null, refusal: "src_hl_down" }], cfg: c };
  }

  const build = (uniformSizeUsd) => (markets || []).map((m) => bestSizeForMarket({
    token: m.token, config: m.config, strategy: m.strategy || "two",
    rows: m.rows, live: m.live, costs, impact: m.impact || null, cfg: c, uniformSizeUsd,
  }));

  // Сжатие требует единого размера, а единый размер требует кривых. Поэтому при w > 0 кривые
  // строятся дважды: первый проход даёт кривые и отбор, второй применяет сжатие. При w = 0 второго
  // прохода нет вовсе, и это ровно тот случай, который исполняется по умолчанию.
  let curves = build(null);
  if (c.shrinkToUniform > 0) {
    const uni = uniformSizeFor(curves, c);
    if (Number.isFinite(uni)) curves = build(uni);
  }

  for (const cur of curves) if (cur.refusal) refusals.push({ token: cur.token, config: cur.config, refusal: cur.refusal });
  const allocated = allocateCapital(curves, capitalTotal, c);
  // Рынок с годной кривой, которому не досталось денег, обязан назвать причину: «капитал кончился»
  // это другое состояние, чем «рынок не окупает круг», и лечится оно другим решением.
  for (const cur of curves) {
    if (!cur.refusal && !allocated.alloc.has(cur.token)) refusals.push({ token: cur.token, config: cur.config, refusal: "no_capital_left" });
  }
  return { ...allocated, curves, refusals, cfg: c };
}

// ─────────────────────────────────────────────────────────────────────────────
// РЕЕСТР ПРЕСЕТОВ. Пресет это ЧИСТЫЕ ДАННЫЕ: ветки исполнения от его имени не зависят, и это
// проверяется тестом, а не обещается. Образец оформления `otmscan/sellhedge.js`.
// ─────────────────────────────────────────────────────────────────────────────

export const FA_SIZING_PRESETS = Object.freeze({
  // БОЕВОЙ. `calibrated: false`, и это не скромность: потолок тикета T и вес сжатия w подобраны на
  // ТЕХ ЖЕ данных, на которых мерились, вложенного отбора не проходили. Замерены здесь горизонт,
  // потолок разбавления, узлы стакана и шаг сетки; НЕ замерены T, minTicket и w.
  "fa-per-market-h720-v1": Object.freeze({
    id: "fa-per-market-h720-v1", calibrated: false,
    why: "T = $5000 и minTicket = $500 это допущения; горизонт, О2 и сетка замерены",
    cfg: Object.freeze({ ...FA_SIZING_DEFAULTS }),
  }),
  // БАЗА СРАВНЕНИЯ: единый размер на все рынки. Выражается тем же правилом при w = 1, а не второй
  // конструкцией: одна формула на три конструкции это единственная раскладка, в которой сравнение
  // рук симметрично по отбору и по потолкам. Асимметрия стенда уже стоила целого вывода.
  "fa-uniform-v1": Object.freeze({
    id: "fa-uniform-v1", calibrated: true,
    why: "оптимум единого размера $3162 на рынок, капитал $199206, $9507 в год (APR 4.77%), воспроизведён дважды",
    cfg: Object.freeze({ ...FA_SIZING_DEFAULTS, shrinkToUniform: 1, ticketCapUsd: Infinity }),
  }),
  // СТРОГИЙ ПЕРИМЕТР: доходом считается только нога GMX, и вход не имеет права сделать нашу сторону
  // большей. Его числа надо показывать РЯДОМ с боевыми, а не вместо них.
  "fa-per-market-strict-v1": Object.freeze({
    id: "fa-per-market-strict-v1", calibrated: false,
    why: "почасовое обнуление дохода при перевороте здесь НЕ реализовано, только потолок на входе",
    cfg: Object.freeze({ ...FA_SIZING_DEFAULTS, gmxOnlyPerimeter: true, flipGuard: true }),
  }),
});

export function faSizingPreset(id) {
  const p = FA_SIZING_PRESETS[id];
  return p ? p.cfg : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ЖУРНАЛ РЕШЕНИЯ
// ─────────────────────────────────────────────────────────────────────────────

const REFUSAL_TEXT = Object.freeze({
  no_capital_cap: "потолок капитала не задан",
  horizon_missing: "горизонт удержания не назван",
  src_gmx_down: "источник GMX недоступен",
  src_hl_down: "источник Hyperliquid недоступен",
  no_base: "базы фандинга нет",
  stale_base: "база устарела",
  base_identity_broken: "база пришла не та: тождество не сошлось",
  no_book: "стакана нет",
  stale_book: "стакан устарел",
  no_funding: "фандинга на рынке нет вовсе",
  no_room: "места меньше минимального билета",
  below_min_ticket: "оптимум ниже минимального билета",
  decreasing_at_every_size: "нетто убывает по размеру всюду",
  negative_at_every_size: "нетто отрицательно на всей сетке",
  below_fund_ratio: "нетто не окупает круг с запасом",
  no_capital_left: "капитал кончился на других рынках",
});

const BINDING_TEXT = Object.freeze({
  gmx: "свободная ликвидность GMX",
  book: "видимый стакан",
  exhausted: "стакан кончается",
  dilution: "потолок разбавления",
  extrapolation_blocked: "край измеренной кривой стакана",
  flip: "запрет становиться большей стороной",
  ticket_cap: "потолок тикета",
  grid: "верх сетки",
  capital: "капитал",
});

// Одна строка на решение. Существует потому, что решение, которого нельзя объяснить оператору, в
// интерфейсе неотличимо от произвольного числа.
export function explainSize(decision) {
  if (!decision) return "решения нет";
  const t = decision.token ?? "?";
  if (decision.refusal) {
    const why = REFUSAL_TEXT[decision.refusal] || decision.refusal;
    return `${t}: не финансируем, ${why} (${decision.refusal})`;
  }
  const bind = decision.binding ? `, связывает ${BINDING_TEXT[decision.binding] || decision.binding}` : "";
  const keep = Number.isFinite(decision.dilutionRetained) ? `, удержим ${(decision.dilutionRetained * 100).toFixed(1)}% потока` : "";
  return `${t}: $${decision.sizeUsd.toFixed(0)} (оптимум $${decision.starUsd.toFixed(0)}${bind}), `
    + `нетто $${decision.netUsd.toFixed(2)} при круге $${decision.costUsd.toFixed(2)}, окупает круг в ${decision.ratio.toFixed(2)} раза${keep}`;
}
