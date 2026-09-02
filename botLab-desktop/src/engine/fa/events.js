// events.js - СОБЫТИЯ ВНЕОЧЕРЕДНОГО РЕШЕНИЯ ПО ОТКРЫТОЙ СДЕЛКЕ. PURE: ни сети, ни файлов, ни Date.now.
//
// ЗАЧЕМ. Дорогие правила зовутся раз в каданс (24 ч, замер в шапке `exit.js`), а за сутки рынок
// успевает измениться: ставка нашей ноги может сменить знак, поток рынка обвалиться, цена уйти к
// ликвидации ноги. Решение владельца 2026-09-02: каданс остаётся, а между кадансами правило зовётся
// ВНЕОЧЕРЕДНО, когда сработало одно из трёх событий. Событие двигает только МОМЕНТ решения; само
// решение принимает то же правило с той же полосой гистерезиса шириной в круг, поэтому на
// неизменившихся данных событие перекладки вызвать не может.
//
// ЧТО СОБЫТИЕ МОЖЕТ И ЧЕГО НЕ МОЖЕТ, честно. Оценка правила это среднее по окну назад (`windowH`,
// 720 ч), и один час новых данных сдвигает её на 1/720. Событие даёт правилу посмотреть раньше, но
// смотреть оно будет тем же средним; сдвинуть исход оно способно там, где сделка уже стояла у края
// полосы. Цена внеочередных решений в кругах НЕ ЗАМЕРЕНА: замерены только края шкалы (каданс 1 ч
// против 24 ч даёт то же нетто при 44 кругах против 27), а события лежат между ними. Пороги ниже
// это ДОПУЩЕНИЯ, названные числом; их цену надо снять по живой записи `fa-dec`, где у каждого
// решения записан повод (`tr`).
//
// ТРИ СОБЫТИЯ, и каждое считается ОТНОСИТЕЛЬНО СНИМКА ПРОШЛОГО РЕШЕНИЯ (`decisionContext`), а не
// абсолютно: иначе событие горело бы тик за тиком, пока условие держится, и правило звалось бы
// каждые пять минут, то есть каданс 5 минут под другим именем.
//   neg_streak - почасовое нетто удерживаемой позиции (тот же разбор ног и то же разбавление, что у
//                леджера) отрицательно последние `eventNegHours` часов подряд, а на прошлом решении
//                полоса была короче порога;
//   pot_drop   - поток рынка `pot` (тождество сторон, `potOf`) упал до доли `1 - eventPotDropFrac`
//                от потока на прошлом решении или ниже;
//   room_drop  - запас до ликвидации худшей ноги сжался на `eventRoomDropFrac` и больше с прошлого
//                решения. Сторож залога закрывает сделку сам при запасе ниже порога; событие зовёт
//                правило раньше, чтобы сравнить сделку с альтернативами, пока запас ещё есть.
//
// ЧАС БЕЗ СТАВОК ИЛИ БЕЗ БАЗЫ ЭТО «НЕИЗВЕСТНО», А НЕ УБЫТОК: он обрывает полосу отрицательных часов.
// Считать пропуск данных убытком значило бы звать решение по дыре, а не по рынку.
//
// ЧЕГО МОДУЛЬ НЕ ИМПОРТИРУЕТ: ничего из `src/engine/btcopt/`. Замыкания импортов ботов пересекаются
// по пустому множеству, у бота 2 идёт живой прогон, и это стережёт тест.

import { legModel } from "../paper.js";
import { dilutedFundingRate, potOf, resolveBase } from "./dilution.js";

// Реестр событий. Каждое обязано быть достижимо тестом и названо словами в интерфейсе.
export const FA_DECISION_EVENTS = Object.freeze(["neg_streak", "pot_drop", "room_drop"]);

// Повод решения: каданс подошёл либо одно из событий. Едет в запись решения полем `tr`, чтобы цену
// внеочередных решений можно было снять задним числом. Закрытие по сторожу залога поводом НЕ
// является: это блокирующий отказ `margin_thin`, правила при нём не зовутся, и у него свой код.
export const FA_DECISION_TRIGGERS = Object.freeze(["cadence", ...FA_DECISION_EVENTS]);

// Пороги событий. ВСЕ ТРИ ДОПУЩЕНИЯ (см. шапку): числа выбраны, а не измерены.
export const FA_EVENT_DEFAULTS = Object.freeze({
  eventNegHours: 6, // часов подряд с отрицательным почасовым нетто
  eventPotDropFrac: 0.5, // поток рынка упал вдвое и больше против прошлого решения
  eventRoomDropFrac: 0.1, // запас до ликвидации сжался на десять пунктов и больше
});

const HOUR_S = 3600;

// Почасовое нетто удерживаемой позиции в долларах за час, тем же разбором ног, что у леджера: нога
// GMX это разбавленный фандинг минус заимствование за секунду на ноционал, нога Hyperliquid это
// ставка за час на ноционал со знаком стороны (`legModel`). Строка без ставок или без годной базы
// даёт null («неизвестно»), а не ноль.
export function hourlyNetUsd(row, { strategy = "two", config = null, sizeUsd } = {}) {
  if (!row || !(sizeUsd > 0)) return null;
  const { gmxSide, hlPerHourSign } = legModel(strategy, config);
  const f = gmxSide === "short" ? row.f_short : row.f_long;
  const b = gmxSide === "short" ? row.b_short : row.b_long;
  if (!Number.isFinite(f) || !Number.isFinite(b)) return null;
  const d = dilutedFundingRate(f, resolveBase(row, gmxSide), sizeUsd);
  if (d.reason === "no_base" || d.reason === "base_identity_broken") return null;
  let perHour = (d.rate - b) * HOUR_S * sizeUsd;
  if (hlPerHourSign !== 0) {
    if (!Number.isFinite(row.hl_rate)) return null;
    perHour += hlPerHourSign * row.hl_rate * sizeUsd;
  }
  return perHour;
}

// Сколько ПОСЛЕДНИХ часов подряд позиция теряла. Неизвестный час обрывает полосу.
export function negativeStreakHours(rows, leg) {
  let n = 0;
  for (let i = (rows?.length ?? 0) - 1; i >= 0; i -= 1) {
    const v = hourlyNetUsd(rows[i], leg);
    if (!(Number.isFinite(v) && v < 0)) break;
    n += 1;
  }
  return n;
}

// Поток рынка сейчас, доллары в секунду, по живому снимку рынка в той форме, в какой его собирает
// главный процесс для тика: `rates` это факторы обеих сторон, `live.bOwnUsd` и `live.bOtherUsd` это
// базы нашей и встречной стороны. Стороны берутся у `legModel`. Несошедшееся тождество даёт null:
// поток, посчитанный по чужой базе, это не наблюдение.
export function marketPotUsdPerSec(market, { strategy = "two", config = null } = {}) {
  const rates = market?.rates;
  const live = market?.live;
  if (!rates || !live) return null;
  const { gmxSide } = legModel(strategy, config);
  const bLong = gmxSide === "short" ? live.bOtherUsd : live.bOwnUsd;
  const bShort = gmxSide === "short" ? live.bOwnUsd : live.bOtherUsd;
  const id = potOf(rates.f_long, bLong, rates.f_short, bShort);
  return id.ok && Number.isFinite(id.pot) ? id.pot : null;
}

// СНИМОК НА МОМЕНТ РЕШЕНИЯ: относительно него меряются события до следующего решения. Снимается
// для рынка, который будет удерживаться ПОСЛЕ исполнения намерения: при входе и перекладке это
// новый рынок, при удержании текущий. Без рынка (кэш, пустой слот) снимка нет.
export function decisionContext({
  token = null, strategy = "two", config = null, sizeUsd = null, rows = null, market = null, roomFrac = null,
} = {}) {
  if (token == null) return null;
  const leg = { strategy, config, sizeUsd };
  return {
    token,
    negHours: rows && rows.length && sizeUsd > 0 ? negativeStreakHours(rows, leg) : null,
    potUsdPerSec: marketPotUsdPerSec(market, { strategy, config }),
    roomFrac: Number.isFinite(roomFrac) ? roomFrac : null,
  };
}

// СОБЫТИЯ НА ТИКЕ. Пусто без открытой сделки, без снимка прошлого решения и на чужом рынке: снимок
// другого рынка сравнивать не с чем. Каждое событие несёт свои числа для журнала.
export function detectDecisionEvents({
  position = null, rows = null, market = null, margin = null, ctx = null, params = FA_EVENT_DEFAULTS,
} = {}) {
  const out = [];
  if (!position || !(position.sizeUsd > 0) || !ctx || ctx.token !== position.token) return out;
  const p = { ...FA_EVENT_DEFAULTS, ...(params || {}) };
  const leg = { strategy: position.strategy || "two", config: position.config ?? null, sizeUsd: position.sizeUsd };

  const k = p.eventNegHours;
  if (Number.isFinite(k) && k > 0 && rows && rows.length) {
    const hours = negativeStreakHours(rows, leg);
    const before = Number.isFinite(ctx.negHours) ? ctx.negHours : 0;
    if (hours >= k && before < k) out.push({ code: "neg_streak", hours, need: k });
  }

  const drop = p.eventPotDropFrac;
  if (Number.isFinite(drop) && drop > 0 && drop < 1 && Number.isFinite(ctx.potUsdPerSec) && ctx.potUsdPerSec > 0) {
    const pot = marketPotUsdPerSec(market, leg);
    if (Number.isFinite(pot) && pot <= ctx.potUsdPerSec * (1 - drop)) {
      out.push({ code: "pot_drop", pot, was: ctx.potUsdPerSec, frac: drop });
    }
  }

  const rd = p.eventRoomDropFrac;
  if (Number.isFinite(rd) && rd > 0 && Number.isFinite(ctx.roomFrac) && Number.isFinite(margin?.roomFrac)) {
    if (margin.roomFrac <= ctx.roomFrac - rd) {
      out.push({ code: "room_drop", roomFrac: margin.roomFrac, was: ctx.roomFrac, frac: rd });
    }
  }
  return out;
}
