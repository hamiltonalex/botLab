// bases.js - БАЗЫ ФАНДИНГА В ОКНЕ ВОРОТ: наблюдение вперёд и долив истории. PURE: ни сети, ни файлов,
// ни Date.now (запрос к индексатору живёт в `sources.js`, оркестрация в `main.js`).
//
// ЗАМЕР, РАДИ КОТОРОГО ЭТОТ МОДУЛЬ СУЩЕСТВУЕТ. Без баз в часовой строке `dilutedFundingRate`
// отдаёт код `no_base` и обнуляет доход КАЖДОГО часа получения: фактор 0 на старом кадре против
// 0.995 на кадре с базами (замер коммита ec6e638). То есть правило входа отказывает каждому рынку,
// и автомат не входит в сделку никогда. Колонки `fbase_long` / `fbase_short` в кадр уже добавлены;
// здесь заведены ДВА источника, которые имеют право их наполнять, и порядок между ними строгий:
// ЖИВОЙ ОПРОС главнее, ИСТОРИЯ ИНДЕКСАТОРА только закрывает часы без наблюдения.
//
// ДОЛИВ ИЗ ИНДЕКСАТОРА РАЗРЕШЁН ДЛЯ ЖИВОГО ОКНА ВОРОТ (решение владельца 2026-09-02; расширение
// запрета 7 на приложение от 2026-08-31 признано ошибкой и снято). Условия, при которых он
// существует, и ни одно не смягчается:
//   * история только ЗАКРЫВАЕТ ЧАСЫ БЕЗ НАБЛЮДЕНИЯ: живое наблюдение главнее и не перезаписывается
//     никогда, при любом расхождении (`backfillBases`);
//   * только окно горизонта ворот и только прошлые полные часы: текущий час принадлежит опросу, а
//     365 суток баз решений не меняют и размывали бы предмет (`baseBackfillWindow`);
//   * каждый час проверяется ТОЖДЕСТВОМ СТОРОН против собственных ставок строки (`potOf`), и час,
//     на котором оно не сошлось, остаётся дырой; дыры ворота терпят до 5% окна;
//   * каждый час окна помнит, откуда взята база (`fbase_src`: `live` или `indexer`), и интерфейс
//     не имеет права назвать долитое наблюдённым.
// Почему это последовательно, а не отступление: кадр ставок на 365 суток и так берётся у того же
// индексатора (`backfill.js`), и ворота считали 720 часов ставок оттуда, отказываясь брать оттуда
// же базы того же часа. Дрейф переиндексации (40.4% часов на младший бит за 71 день) это дрейф
// СТАВОК на уровне разрядности, и ставки его уже терпят; для баз он ниже точности решения (сверка
// живой базы `markets/info` с индексатором: медиана 0.38%, максимум 3.36%, шапка `potOf`).
// Запрет 7 исследования («не пересобирать бектест свежим запросом») ОСТАЁТСЯ: книги охраны сеть
// не трогают и баз из индексатора не видят.
//
// ГРАНИЦА ТОЖДЕСТВА, НАЗВАННАЯ, А НЕ ВЫЛЕЧЕННАЯ. Оно ловит нули при живом рынке (настоящий дефект
// индексатора: 4.88% записей второго года на 23 именах, худшее FIL 5.38%) и перепутанные стороны,
// и НЕ ловит общий множитель у обеих сторон (шапка `potOf` в `dilution.js`).
//
// ПОЧЕМУ ЖУРНАЛ, А НЕ ЗАПИСЬ ПРЯМО В КАДР. Кадр трейлинга приходит из ИСТОРИЧЕСКОГО запроса и
// отстаёт на час-два: строки текущего часа в нём ещё НЕТ. Дописать в кадр строку с одной базой и
// без ставок нельзя двумя разными способами сразу:
//   * `getFrame` берёт начало долива как `последний час кадра + 1 час`, поэтому частичная строка
//     часа H увела бы долив на H+1 и ставки часа H не были бы получены НИКОГДА;
//   * `frameIsFresh` смотрит на последнюю строку, поэтому кадр с частичной строкой текущего часа
//     выглядел бы вечно свежим и долив не запускался бы вовсе.
// Оба дефекта тихие и лечатся одинаково: наблюдение живёт в отдельном журнале и переносится в
// строку тогда, когда строка появилась. Перенос идемпотентен, поэтому повторное применение
// журнала ничего не двигает.
//
// ПЕРВОЕ НАБЛЮДЕНИЕ ЧАСА ВЫИГРЫВАЕТ. Внутри часа опрос проходит несколько раз (при кадансе 5 минут
// двенадцать), и любая внутричасовая выборка базы одинаково представительна: разбавление считается
// множителем `B/(B+S)` того часа, а не мгновением. Выбор первого наблюдения даёт журналу свойство
// «дописывается, а не переписывается»: файл меняется не чаще раза в час на инструмент, и запись на
// диск идёт из этого же факта, а не из отдельного троттлинга.
//
// СМЕЩЕНИЕ ЧАСТИЧНОГО ПОКРЫТИЯ ОДНОСТОРОННЕЕ, И ЭТО ДОКАЗАТЕЛЬСТВО, А НЕ НАБЛЮДЕНИЕ. Час без базы
// теряет доход (правило: базы нет значит доход ноль), а час уплаты не масштабируется вовсе
// (правило 3 разбавления). Значит оценка на неполном покрытии есть ОЦЕНКА СНИЗУ, и ошибиться она
// может только в сторону отказа от входа. Обратное неверно для УДЕРЖАНИЯ: заниженное брутто
// удержания толкает правило выхода в кэш и в перекладку, то есть стоит круга издержек. Отсюда
// гейт покрытия у автомата ОДИН И ТОТ ЖЕ для входа и для удержания, и живёт он в `auto.js`.
//
// ЧЕГО МОДУЛЬ НЕ ИМПОРТИРУЕТ: ничего из `src/engine/btcopt/`. Замыкания импортов ботов 1 и 2
// пересекаются по пустому множеству, у бота 2 идёт живой прогон, и это стережёт тест.

import { potOf, resolveBase } from "./dilution.js";

// ОТКУДА ВЗЯТА БАЗА ЧАСА. `live` это наблюдение опроса `markets/info`, `indexer` это долив истории.
// Час с базой и без метки (кадр, записанный до появления колонки) идёт в счётчик «неизвестно», а
// не приписывается живому: приписать значило бы назвать наблюдённым то, чего никто не видел.
export const FA_BASE_SOURCES = Object.freeze(["live", "indexer"]);

// Версия формы журнала. Читатель обязан пережить чужую версию, а не молча принять её за свою.
export const FA_BASE_JOURNAL_VERSION = 1;

// Сколько часов наблюдений держать. ДОПУЩЕНИЕ, а не замер. Обоснование величины: журнал это
// ПРОМЕЖУТОЧНЫЙ буфер между наблюдением и появлением часовой строки, а строка запаздывает на
// STALE_AFTER_SEC (2 часа) плюс каданс долива. Неделя это запас в 84 раза, и она же покрывает
// восстановление баз после ПРИНУДИТЕЛЬНОГО полного бэкфилла кадра, который стирает колонки
// (`getFrame` при `force` не читает кэш вовсе). Сеткой по этому числу никто не гонял.
export const FA_BASE_JOURNAL_HOURS = 168;

// Пустой журнал. Форма одна на создание, чтение и миграцию: две формы это второй способ ошибиться.
export function emptyBaseJournal() {
  return { v: FA_BASE_JOURNAL_VERSION, obs: [] };
}

// Поднять журнал произвольной формы до рабочей. Чужая версия и битая запись дают ПУСТОЙ журнал, а
// не исключение: наблюдения копятся вперёд, потерянный буфер стоит нескольких часов покрытия, а
// упавший опрос стоит всего прогона.
export function normalizeBaseJournal(journal) {
  if (!journal || typeof journal !== "object" || journal.v !== FA_BASE_JOURNAL_VERSION) return emptyBaseJournal();
  const obs = [];
  for (const o of Array.isArray(journal.obs) ? journal.obs : []) {
    if (!Array.isArray(o) || o.length < 3) continue;
    const [h, bl, bs] = o;
    if (!Number.isFinite(h) || !Number.isFinite(bl) || !Number.isFinite(bs)) continue;
    obs.push([h, bl, bs]);
  }
  obs.sort((a, b) => a[0] - b[0]);
  return { v: FA_BASE_JOURNAL_VERSION, obs: obs.slice(-FA_BASE_JOURNAL_HOURS) };
}

// Записать наблюдение часа. Возвращает НОВЫЙ журнал и признак изменения: писателю на диск нужен
// именно признак, иначе кадр перезаписывался бы каждый опрос ни за что.
//
// Обе стороны обязаны быть конечными. Односторонняя запись невозможна по построению источника:
// `openInterestLong` и `openInterestShort` приходят одним ответом `markets/info`, и если нет одной,
// то нет и второй. Ноль при этом ЗАПИСЫВАЕТСЯ: «интерес стороны равен нулю» это наблюдение, а не
// пропуск, и `resolveBase` отказывает по нему своим кодом.
export function observeBases(journal, { tsHour, fbaseLongUsd, fbaseShortUsd } = {}) {
  const cur = normalizeBaseJournal(journal);
  if (!Number.isFinite(tsHour)) return { journal: cur, changed: false };
  if (!Number.isFinite(fbaseLongUsd) || !Number.isFinite(fbaseShortUsd)) return { journal: cur, changed: false };
  if (fbaseLongUsd < 0 || fbaseShortUsd < 0) return { journal: cur, changed: false };
  // Первое наблюдение часа выигрывает: журнал дописывается, а не переписывается.
  if (cur.obs.some((o) => o[0] === tsHour)) return { journal: cur, changed: false };
  const obs = [...cur.obs, [tsHour, fbaseLongUsd, fbaseShortUsd]].sort((a, b) => a[0] - b[0]);
  return { journal: { v: FA_BASE_JOURNAL_VERSION, obs: obs.slice(-FA_BASE_JOURNAL_HOURS) }, changed: true };
}

// Перенести наблюдения в строки кадра. Возвращает строки и число применённых наблюдений. Час,
// заполненный отсюда, помечается `fbase_src: "live"`: журнал пишется только живым опросом.
//
// НАБЛЮДЕНИЕ КАДРА СИЛЬНЕЕ ЖУРНАЛА: строка, у которой база уже стоит, не трогается. Журнал это
// буфер до появления строки, а не второй источник истины, и перезапись сделала бы порядок
// применения значимым. Строки, которых наблюдение не касается, возвращаются ТЕМИ ЖЕ объектами:
// копия всего кадра на каждый опрос это 8760 объектов ни за что.
export function applyObservedBases(rows, journal) {
  const cur = normalizeBaseJournal(journal);
  if (!rows || !rows.length || !cur.obs.length) return { rows: rows || [], applied: 0 };
  const byHour = new Map(cur.obs.map((o) => [o[0], o]));
  let applied = 0;
  const out = rows.map((r) => {
    if (!r || !Number.isFinite(r.tsHour)) return r;
    const o = byHour.get(r.tsHour);
    if (!o) return r;
    const needLong = !Number.isFinite(r.fbase_long);
    const needShort = !Number.isFinite(r.fbase_short);
    if (!needLong && !needShort) return r;
    applied += 1;
    return {
      ...r,
      fbase_long: needLong ? o[1] : r.fbase_long,
      fbase_short: needShort ? o[2] : r.fbase_short,
      fbase_src: "live",
    };
  });
  return { rows: applied ? out : rows, applied };
}

// ОКНО ДОЛИВА: часы горизонта ворот, у которых базы нет, среди ПРОШЛЫХ ПОЛНЫХ часов. Возвращает
// первый и последний недостающий час и их число, либо null, когда доливать нечего: тогда и сети
// нет. Текущий час в окно не входит по построению: он принадлежит живому опросу, а история за него
// ещё не написана. Дальше горизонта окно не тянется: 365 суток баз дёшевы, но решений не меняют.
export function baseBackfillWindow(rows, { nowHour, horizonH } = {}) {
  if (!rows || !rows.length || !Number.isFinite(nowHour) || !(horizonH > 0)) return null;
  const lo = nowHour - horizonH * 3600;
  const hi = nowHour - 3600;
  let fromHour = null;
  let toHour = null;
  let hours = 0;
  for (const r of rows) {
    if (!r || !Number.isFinite(r.tsHour) || r.tsHour < lo || r.tsHour > hi) continue;
    if (Number.isFinite(r.fbase_long) || Number.isFinite(r.fbase_short)) continue;
    hours += 1;
    if (fromHour == null || r.tsHour < fromHour) fromHour = r.tsHour;
    if (toHour == null || r.tsHour > toHour) toHour = r.tsHour;
  }
  return hours ? { fromHour, toHour, hours } : null;
}

// ДОЛИВ ИСТОРИИ В СТРОКИ КАДРА. `hist` это Map(tsHour -> { fbase_long, fbase_short }) из
// `fetchGmxFundingBalanceHistory`, окно `[fromHour, toHour]` обязательно (без него доливать
// нельзя: границу окна называет оркестрация, а не история). Возвращает строки и счётчики:
//   filled   - часов, заполненных из истории (нулевые входят сюда же);
//   zero     - из них часов, где хотя бы одна база равна нулю: это НАБЛЮДЕНИЕ («интереса стороны
//              нет»), а не пропуск, и отказывает по нему `resolveBase` своим кодом;
//   rejected - часов, у которых тождество сторон против собственных ставок строки не сошлось;
//              они НЕ заполнены и остаются дырой, а не чужим числом;
//   missing  - часов окна, оставшихся без базы после слияния (нет в истории либо отвергнуты).
//
// ЖИВОЕ НАБЛЮДЕНИЕ НЕ ПЕРЕЗАПИСЫВАЕТСЯ НИКОГДА: заполняются только строки, у которых нет ОБЕИХ
// баз, как в `applyObservedBases`. Своей проверки тождества здесь нет: вердикт даёт `potOf`, и
// второй реализации быть не может. Нетронутые строки возвращаются ТЕМИ ЖЕ объектами; кадр без
// единого долитого часа возвращается тем же массивом, поэтому отказ источника (пустая карта) кадр
// не меняет ни на бит.
export function backfillBases(rows, hist, { fromHour, toHour } = {}) {
  const out = { rows: rows || [], filled: 0, rejected: 0, zero: 0, missing: 0 };
  if (!rows || !rows.length || !Number.isFinite(fromHour) || !Number.isFinite(toHour)) return out;
  const h = hist instanceof Map ? hist : new Map();
  let changed = false;
  const next = rows.map((r) => {
    if (!r || !Number.isFinite(r.tsHour) || r.tsHour < fromHour || r.tsHour > toHour) return r;
    if (Number.isFinite(r.fbase_long) || Number.isFinite(r.fbase_short)) return r; // строка с базой сильнее
    const x = h.get(r.tsHour);
    const usable = x && Number.isFinite(x.fbase_long) && Number.isFinite(x.fbase_short) && x.fbase_long >= 0 && x.fbase_short >= 0;
    if (!usable) {
      out.missing += 1;
      return r;
    }
    if (!potOf(r.f_long, x.fbase_long, r.f_short, x.fbase_short).ok) {
      out.rejected += 1;
      out.missing += 1;
      return r;
    }
    out.filled += 1;
    if (!(x.fbase_long > 0) || !(x.fbase_short > 0)) out.zero += 1;
    changed = true;
    return { ...r, fbase_long: x.fbase_long, fbase_short: x.fbase_short, fbase_src: "indexer" };
  });
  out.rows = changed ? next : rows;
  return out;
}

// Покрытие окна базами НАШЕЙ стороны. Годность часа определяет `resolveBase`, а не собственная
// проверка: у базы есть тождество сторон, и второй его реализации здесь быть не может.
//
// Возвращает и `covered`, и `hours`, потому что «окна нет» и «окно есть, баз в нём нет» это разные
// состояния с разными кодами отказа у автомата.
//
// ПОКРЫТИЕ ДЕЛИТСЯ ПО ПРОИСХОЖДЕНИЮ: `coveredLive` наблюдено опросом, `coveredIndexer` долито из
// истории, `coveredUnknown` покрыто без метки (кадр до появления колонки). Сумма трёх равна
// `covered`. Ворота смотрят на сумму, интерфейс обязан показывать разбивку: назвать долитое
// наблюдённым он не имеет права.
export function baseCoverage(rows, gmxSide) {
  let covered = 0;
  let coveredLive = 0;
  let coveredIndexer = 0;
  let coveredUnknown = 0;
  const hours = rows?.length ?? 0;
  for (const r of rows || []) {
    const b = resolveBase(r, gmxSide);
    if (!(b.ok && Number.isFinite(b.bOwnUsd) && b.bOwnUsd > 0)) continue;
    covered += 1;
    if (r.fbase_src === "live") coveredLive += 1;
    else if (r.fbase_src === "indexer") coveredIndexer += 1;
    else coveredUnknown += 1;
  }
  return {
    hours, covered, missing: hours - covered, fraction: hours > 0 ? covered / hours : 0,
    coveredLive, coveredIndexer, coveredUnknown,
  };
}
