// fa-archive.js - СВОДКА АРХИВА ЗАПИСИ ДЛЯ ОПЕРАТОРА. PURE: ни файлов, ни `Date.now` (строки и
// ключ суток приходят параметрами). Слой main ПОВЕРХ движка, прецедент `fa-eval.js`.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ ЕСТЬ. В `engine/fa/record.js` шесть читателей архива написаны и покрыты тестами,
// но приложением НЕ ЗВАЛИСЬ НИ РАЗУ: `faCoverage`, `faVanishedMarkets`, `faUnknownCodes`,
// `faLiqRoom`, `faVolumePerDay`, `faRecordsToPrune`. Главный из них, `faCoverage`, назван в самом
// движке «главным контролем записи»: перерыв без строки пропуска попадает в `unexplained`, и
// молчаливая дыра в ленте неотличима от рынка, которого не было. Контроль, который считается только
// в тестах, оператора ни от чего не защищает.
//
// ПОЧЕМУ АГРЕГАЦИЯ ЗДЕСЬ, А НЕ В `main.js` И НЕ В ОТРИСОВЩИКЕ. В `main.js` она была бы вне теста:
// файл тянет Electron и под `node --test` не идёт, о чём сказано в нём самом. В отрисовщике она
// нарушала бы закон проекта «считает главный процесс, отрисовщик рисует»: развернуть словарь причин
// в отсортированный список, свести коды в счётчики и найти минимум запаса это счёт, а не показ.
//
// ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО. Ни одного порога и ни одного вердикта. Запас до ликвидации приходит
// сюда МОДУЛЕМ расстояния (`faLiqRoom`), без знака и без сравнения с требуемой долей; решает,
// хватает его или нет, `marginGuard` на карточке честности. Второй вердикт о риске мимо сторожа
// это ровно тот класс дефекта, из-за которого карточка начинает противоречить движку.

import {
  faCoverage, faLiqRoom, faRecordsToPrune, faUnknownCodes, faVanishedMarkets, faVolumePerDay,
} from "../engine/fa/record.js";

// Потолок длины ЛЮБОГО массива в ответе. Архив за год это мегабайты, и список из тысячи имён на
// карточке никто не читает; сколько всего нашлось, едет рядом числом, поэтому обрезка не скрывает.
export const FA_ARCHIVE_CAP = 12;

// Горизонты предпросмотра срока хранения. ЗАШИТЫ СПИСКОМ И НЕ НАСТРАИВАЮТСЯ, и это не упущение:
// срок хранения это решение владельца, а оно не принято. Настроечное поле, заведённое раньше
// решения, само стало бы решением.
export const FA_ARCHIVE_KEEP_PREVIEW = Object.freeze([30, 90, 180, 365]);

const fin = (x) => Number.isFinite(x);
const DAY_MS = 86400000;

// ── ПРИЧИНЫ ПЕРЕРЫВОВ. Словарь `byCause` разворачивается в отсортированный список ЗДЕСЬ: сортировка
// словаря в отрисовщике это счёт, а показ должен оставаться показом.
function causeList(byCause) {
  return Object.entries(byCause || {})
    .map(([cause, n]) => ({ cause, n }))
    .sort((a, b) => b.n - a.n || String(a.cause).localeCompare(String(b.cause)));
}

// ── КОДЫ ВНЕ РЕЕСТРОВ. `faUnknownCodes` отвечает ПРО ОДНУ СТРОКУ, поэтому счёт ведётся здесь.
// Считаются СТРОКИ с кодом, а не вхождения: внутри строки читатель уже дедуплицирует.
function unknownCodes(streams) {
  const by = new Map();
  for (const [kind, rows] of streams) {
    for (const r of rows || []) {
      for (const code of faUnknownCodes(r)) {
        const cur = by.get(code) || { code, rows: 0, firstAt: null, lastAt: null, kinds: new Set() };
        cur.rows += 1;
        cur.kinds.add(kind);
        if (fin(r?.t)) {
          if (cur.firstAt == null || r.t < cur.firstAt) cur.firstAt = r.t;
          if (cur.lastAt == null || r.t > cur.lastAt) cur.lastAt = r.t;
        }
        by.set(code, cur);
      }
    }
  }
  return [...by.values()]
    .map((x) => ({ ...x, kinds: [...x.kinds].sort() }))
    .sort((a, b) => b.rows - a.rows || a.code.localeCompare(b.code));
}

// ── ЗАПАС ДО ЛИКВИДАЦИИ ПО ЗАПИСИ. Отдаются последняя точка, минимум по каждой ноге и счёт ярлыков
// источника цены ликвидации. Ленту из тысяч точек наружу не отдаём: на экране её никто не смотрит,
// а вопрос «насколько близко подходили» закрывается минимумом с меткой времени.
function liqSummary(snaps) {
  const out = {
    snapsWithPos: 0,
    last: null,
    min: { gmx: null, hl: null },
    srcCount: { venue: 0, model: 0, unknown: 0 },
  };
  for (const r of snaps) {
    const room = faLiqRoom(r);
    if (!room) continue;
    out.snapsWithPos += 1;
    out.last = { at: r.t ?? null, gmx: room.gmx, hl: room.hl, src: room.src };
    for (const leg of ["gmx", "hl"]) {
      const v = room[leg];
      if (fin(v) && (out.min[leg] == null || v < out.min[leg].v)) out.min[leg] = { v, at: r.t ?? null };
      const s = room.src ? room.src[leg] : null;
      // Нога, которой у схемы НЕТ, ярлыка не имеет и в счёт источников не идёт: считать её
      // «источник неизвестен» значило бы завести пропуск наблюдения там, где наблюдать нечего.
      // А вот нога С расстоянием и БЕЗ ярлыка это пропуск наблюдения, и он идёт в `unknown`.
      if (!fin(v)) continue;
      if (s === "venue") out.srcCount.venue += 1;
      else if (s === "model") out.srcCount.model += 1;
      else out.srcCount.unknown += 1;
    }
  }
  return out;
}

// ── ЧАСТОТЫ ЗАМЕРА ОБЪЁМА. Берутся ИЗ ПРОЧИТАННОГО ОКНА, а не назначаются: замер `faVolumePerDay`
// честен ровно настолько, насколько честны его входы, и подставить туда умолчания значило бы выдать
// допущение за наблюдение. `spanDays` едет наружу, потому что частота, снятая с окна короче суток,
// это оценка по одному-двум событиям, и читатель обязан это видеть.
function measuredInputs({ snaps, gaps, decRows, tradeRows, pollSec, fromAt, toAt }) {
  const spanMs = fin(fromAt) && fin(toAt) && toAt > fromAt ? toAt - fromAt : 0;
  const spanDays = spanMs > 0 ? spanMs / DAY_MS : 0;
  const lastSnap = snaps.length ? snaps[snaps.length - 1] : null;
  const lastDec = decRows.length ? decRows[decRows.length - 1] : null;
  // ЧИСЛИТЕЛЬ И ЗНАМЕНАТЕЛЬ ИЗ ОДНОГО ОКНА, и это не педантизм. Вызывающий читает каждый поток
  // своим списком СУЩЕСТВУЮЩИХ суточных файлов, а файл сделок заводится только в те сутки, когда
  // сделка была: тридцать файлов сделок покрывают год, а окно снимков тридцать суток. Деление
  // одного на другое давало «сделок в сутки» завышенным в разы, причём тем сильнее, чем дольше
  // работает бот.
  const inWin = (rows) => (spanMs > 0 ? rows.filter((r) => fin(r?.t) && r.t >= fromAt && r.t <= toAt) : []);
  const per = (n) => (spanDays > 0 ? n / spanDays : null);
  return {
    spanDays,
    markets: lastSnap && lastSnap.m ? Object.keys(lastSnap.m).length : null,
    pollSec: fin(pollSec) ? pollSec : null,
    funded: lastDec && Array.isArray(lastDec.mk) ? lastDec.mk.length : null,
    decisionsPerDay: per(inWin(decRows).length),
    tradesPerDay: per(inWin(tradeRows).length),
    gapsPerDay: per(inWin(gaps).length),
    positionOpen: !!(lastSnap && lastSnap.p),
  };
}

// ── СРОК ХРАНЕНИЯ, СОСЛАГАТЕЛЬНО. `faRecordsToPrune` НИЧЕГО НЕ УДАЛЯЕТ и удалять не умеет, это
// записано в ней самой. Здесь она зовётся только для ответа на вопрос «что вышло бы за срок», и
// канала на удаление нет ни в мосте, ни в главном процессе; это стережёт тест.
function retentionPreview(dayKeys, todayKey, horizons) {
  const streams = Object.entries(dayKeys || {});
  const oldest = {};
  for (const [k, days] of streams) oldest[k] = days && days.length ? days[0] : null;
  const preview = (horizons || []).map((keepDays) => {
    const expire = {};
    // СЧИТАЮТСЯ СУТКИ, А НЕ ПАРЫ «ПОТОК-СУТКИ». Одни и те же сутки лежат во всех трёх потоках, и
    // сумма длин трёх списков давала бы тройное число под подписью «вышло бы за срок суток»: на
    // архиве в сто суток это 210 против настоящих 70, то есть больше, чем суток вообще есть.
    const uniq = new Set();
    for (const [k, days] of streams) {
      const list = faRecordsToPrune(days, keepDays, todayKey);
      expire[k] = list.slice(0, FA_ARCHIVE_CAP);
      for (const d of list) uniq.add(d);
    }
    return { keepDays, n: uniq.size, expire };
  });
  return { todayKey: todayKey ?? null, oldest, preview };
}

// faArchiveSummary - единственный ответ канала `fa:auto:archive`. Строки уже прочитаны с диска
// вызывающим: этот модуль диска не знает.
//
//   snapRows   - поток `fa-snap` ЦЕЛИКОМ, вместе со строками пропуска: писатель кладёт их в тот же
//                файл, и `faCoverage` разбирает их по полю `k` сам;
//   nominalSec - период опроса СЕЙЧАС. Если внутри окна его меняли, покрытие посчитано по нынешнему
//                и является оценкой; сказать об этом обязана карточка, а не этот модуль;
//   bytes      - занято на диске по трём префиксам, факт против замера;
//   dayKeys    - ключи суток по трём префиксам, для сослагательного срока хранения.
export function faArchiveSummary({
  snapRows = [], decRows = [], tradeRows = [],
  nominalSec = null, warmupRows = 1, tailRows = 1,
  bytes = null, dayKeys = null, todayKey = null,
  keepPreviewDays = FA_ARCHIVE_KEEP_PREVIEW,
  broken = null, daysRead = null,
} = {}) {
  const snaps = (snapRows || []).filter((r) => r?.k === "snap" && fin(r.t)).sort((a, b) => a.t - b.t);
  const gaps = (snapRows || []).filter((r) => r?.k === "gap");
  const decs = (decRows || []).filter(Boolean).sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  const trades = (tradeRows || []).filter(Boolean).sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  const fromAt = snaps.length ? snaps[0].t : null;
  const toAt = snaps.length ? snaps[snaps.length - 1].t : null;

  const cov = faCoverage(snapRows || [], { nominalSec });
  // Необъяснённые перерывы отдаются САМЫЕ ДЛИННЫЕ: их может быть много, а вопрос у оператора один -
  // где потеряно больше всего. Сколько их всего, едет числом рядом.
  const worst = [...(cov.unexplained || [])].sort((a, b) => b.ms - a.ms).slice(0, FA_ARCHIVE_CAP);

  const van = faVanishedMarkets(snapRows || [], { warmupRows, tailRows });
  const codes = unknownCodes([["snap", snapRows], ["dec", decs], ["trade", trades]]);
  const measured = measuredInputs({ snaps, gaps, decRows: decs, tradeRows: trades, pollSec: nominalSec, fromAt, toAt });
  // Замер объёма имеет смысл только когда есть чем его кормить: без рынков и без периода опроса
  // `faVolumePerDay` вернул бы числа по своим умолчаниям, то есть чужой ответ под видом нашего.
  //
  // ОКНО КОРОЧЕ СУТОК ЗАМЕРОМ НЕ СЧИТАЕТСЯ, и это не осторожность. Частота «в сутки», снятая с
  // четырёх минут, это умножение одного события на 360: живой прогон дал 3.54 МБ в сутки там, где
  // правда около 0.6 МБ. Оговоркой такое число не чинится - оно просто неверно, а карточка,
  // печатающая неверное число с оговоркой, и есть интерфейс, который врёт.
  const canProject = fin(measured.markets) && fin(measured.pollSec) && measured.pollSec > 0
    && measured.spanDays >= 1
    && fin(measured.decisionsPerDay) && fin(measured.tradesPerDay) && fin(measured.gapsPerDay);
  const perDay = canProject ? faVolumePerDay({
    markets: measured.markets, pollSec: measured.pollSec, funded: measured.funded,
    decisionsPerDay: measured.decisionsPerDay, tradesPerDay: measured.tradesPerDay,
    gapsPerDay: measured.gapsPerDay, positionOpen: measured.positionOpen,
  }) : null;

  return {
    window: {
      daysRead: fin(daysRead) ? daysRead : null,
      fromAt, toAt, pollSec: fin(nominalSec) ? nominalSec : null,
      broken: broken || null,
    },
    coverage: {
      polls: cov.polls, expected: cov.expected, coveragePct: cov.coveragePct, lostSlots: cov.lostSlots,
      byCause: causeList(cov.byCause),
      explained: { n: (cov.explained || []).length },
      unexplained: { n: (cov.unexplained || []).length, worst },
    },
    vanished: {
      warmupRows, tailRows, n: van.length,
      markets: van.slice(0, FA_ARCHIVE_CAP),
      // ХВАТИЛО ЛИ ЛЕНТЫ, ЧТОБЫ ВООБЩЕ ЗАМЕТИТЬ ИСЧЕЗНОВЕНИЕ. Читатель возвращает пустой список и
      // когда никто не исчез, и когда строк меньше, чем требует окно сравнения. Живой прогон
      // показал цену молчания: пять снимков против окна в 60 строк с каждого конца дали на экране
      // «ни одно имя не исчезло», то есть отсутствие наблюдения выглядело как наблюдение.
      enough: snaps.length >= warmupRows + tailRows,
      snaps: snaps.length,
    },
    codes: { n: codes.length, items: codes.slice(0, FA_ARCHIVE_CAP) },
    liq: liqSummary(snaps),
    volume: { measured, perDay, onDisk: bytes || null },
    retention: retentionPreview(dayKeys, todayKey, keepPreviewDays),
    cap: FA_ARCHIVE_CAP,
  };
}
