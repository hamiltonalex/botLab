// Сводка архива записи для оператора (`src/main/fa-archive.js`).
//
// ЧТО ИМЕННО ЗДЕСЬ СТЕРЕЖЁТСЯ. Шесть читателей архива в движке были написаны и покрыты тестами, но
// приложением не звались ни разу, то есть «главный контроль записи» считался только в тестах. Этот
// файл проверяет слой, который их наконец зовёт: что каждый позван, что счёт ведётся ЗДЕСЬ, а не в
// отрисовщике, и что обрезка длинных списков не прячет их настоящую длину.
//
// ОТДЕЛЬНО И ГЛАВНОЕ: что предпросмотр срока хранения НИЧЕГО НЕ УДАЛЯЕТ. Решения об удалении
// владелец не принимал, и проверка этого стоит здесь, а не в обещании.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFaDecisionRecord, buildFaGapRecord, buildFaSnapRecord, buildFaTradeRecord,
} from "../src/engine/fa/record.js";
import { FA_ARCHIVE_CAP, FA_ARCHIVE_KEEP_PREVIEW, faArchiveSummary } from "../src/main/fa-archive.js";

const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);
const MIN = 60000;
const NOM = 300; // пять минут, как в поставке

const leg = (over = {}) => ({
  notionalUsd: 2500, collateralUsd: 2500, markPx: 2500, liquidationPx: 5000, liqSource: "model", ...over,
});
const market = (token, over = {}) => ({
  token, chain: "arbitrum", gateOk: true,
  factors: { f_long: -1e-9, f_short: 4e-9, b_long: 0, b_short: 0 },
  hlRate: 0, hlPremium: 0, fbaseLongUsd: 2e6, fbaseShortUsd: 5e5,
  availLongUsd: 1e6, availShortUsd: 1e6, markPx: 2500, maxLev: 20,
  book: { visibleNtl: 1e6, exhaustedFrom: null, nodes: [{ sizeUsd: 1000, bps: 0.2 }] },
  bookAgeSec: 0.5, ...over,
});
const snap = (min, tokens, position = null) => buildFaSnapRecord({
  t: T0 + min * MIN, gmxAgeSec: 1, hlAgeSec: 1,
  markets: tokens.map((x) => market(x)), position,
});
const gap = (fromMin, toMin, hints) => buildFaGapRecord({
  fromMs: T0 + fromMin * MIN, toMs: T0 + toMin * MIN, nominalSec: NOM, hints,
});

test("сводка зовёт покрытие и разворачивает причины перерывов в отсортированный список", () => {
  const rows = [
    snap(0, ["BTC"]), snap(5, ["BTC"]),
    // Дыра в 60 минут, объяснённая строкой пропуска: причина обязана попасть в счёт по причинам.
    gap(5, 65, { sleepWindow: { start: T0 + 10 * MIN, end: T0 + 60 * MIN } }),
    snap(65, ["BTC"]), snap(70, ["BTC"]),
    // Вторая дыра БЕЗ строки пропуска: она и есть тот самый молчаливый провал ленты. Начинается она
    // ПОЗЖЕ конца первой намеренно: читатель считает перерыв объяснённым по ПЕРЕСЕЧЕНИЮ, и дыра,
    // соприкасающаяся с чужой строкой пропуска хотя бы мгновением, считалась бы объяснённой ею.
    snap(200, ["BTC"]),
  ];
  const s = faArchiveSummary({ snapRows: rows, nominalSec: NOM });
  assert.equal(s.coverage.polls, 5);
  assert.equal(s.coverage.explained.n, 1, "перерыв со строкой пропуска объяснён");
  assert.equal(s.coverage.unexplained.n, 1, "перерыв без строки пропуска назван необъяснённым");
  assert.deepEqual(s.coverage.byCause, [{ cause: "sleep", n: 1 }]);
  assert.ok(s.coverage.coveragePct < 100, "дыры обязаны опустить покрытие");
  assert.equal(s.coverage.unexplained.worst[0].ms, 130 * MIN, "самый длинный перерыв идёт первым");
});

test("покрытие без периода опроса не выдумывается: процент null, а не ноль", () => {
  const s = faArchiveSummary({ snapRows: [snap(0, ["BTC"]), snap(5, ["BTC"])] });
  assert.equal(s.coverage.coveragePct, null, "«не посчитано» и «ноль процентов» это разные ответы");
  assert.equal(s.window.pollSec, null);
});

test("рынки, пропавшие из опроса, считаются окном сравнения, и окно едет наружу", () => {
  const rows = [snap(0, ["BTC", "ETH"]), snap(5, ["BTC", "ETH"]), snap(10, ["BTC"]), snap(15, ["BTC"])];
  const s = faArchiveSummary({ snapRows: rows, nominalSec: NOM, warmupRows: 2, tailRows: 2 });
  assert.deepEqual(s.vanished.markets, ["ETH"]);
  assert.equal(s.vanished.n, 1);
  assert.equal(s.vanished.warmupRows, 2, "без окна список имён нечем масштабировать");
  assert.equal(s.vanished.tailRows, 2);
});

test("коды вне реестров сводятся по всем трём потокам, счёт идёт по СТРОКАМ", () => {
  // Причина перерыва вне реестра и событие сделки вне реестра: писатель кладёт их как пришло,
  // а этот слой обязан их пересчитать, а не проглотить.
  const badGap = { ...gap(5, 65, {}), c: "телепортация" };
  const rows = [snap(0, ["BTC"]), badGap, snap(65, ["BTC"])];
  const dec = buildFaDecisionRecord({
    t: T0, capitalUsd: 2500, universe: { curves: [], refusals: [{ token: "BTC", refusal: "выдумка" }] },
  });
  const s = faArchiveSummary({ snapRows: rows, decRows: [dec], nominalSec: NOM });
  const codes = s.codes.items.map((x) => x.code).sort();
  assert.deepEqual(codes, ["gap:телепортация", "refuse:выдумка"]);
  assert.equal(s.codes.n, 2);
  const one = s.codes.items.find((x) => x.code === "gap:телепортация");
  assert.equal(one.rows, 1);
  assert.deepEqual(one.kinds, ["snap"], "поток, в котором код встретился, назван");
});

test("пустой список кодов вне реестров это НОРМА, а не отсутствие данных", () => {
  const s = faArchiveSummary({ snapRows: [snap(0, ["BTC"])], nominalSec: NOM });
  assert.equal(s.codes.n, 0);
  assert.deepEqual(s.codes.items, []);
});

test("запас до ликвидации: последняя точка, минимум за окно и ярлык источника цены", () => {
  const pos = (liqPx) => ({
    token: "BTC", config: "A", strategy: "two",
    gmx: leg({ liquidationPx: liqPx }), hl: leg({ liquidationPx: 1250, liqSource: "venue" }),
  });
  const rows = [snap(0, ["BTC"], pos(5000)), snap(5, ["BTC"], pos(3750)), snap(10, ["BTC"], pos(4500))];
  const s = faArchiveSummary({ snapRows: rows, nominalSec: NOM });
  assert.equal(s.liq.snapsWithPos, 3);
  assert.equal(s.liq.last.gmx, 0.8, "последняя точка это ПОСЛЕДНЯЯ, а не лучшая");
  assert.equal(s.liq.min.gmx.v, 0.5, "минимум за окно");
  assert.equal(s.liq.min.gmx.at, T0 + 5 * MIN, "минимум без метки времени ни о чём не говорит");
  assert.equal(s.liq.srcCount.model, 3, "нога GMX всегда по модели");
  assert.equal(s.liq.srcCount.venue, 3, "нога Hyperliquid по бирже");
  assert.equal(s.liq.srcCount.unknown, 0);
});

test("у одноногой схемы ноги Hyperliquid НЕТ, и в счёт источников она не идёт", () => {
  const rows = [snap(0, ["BTC"], { token: "BTC", config: null, strategy: "one", gmx: leg(), hl: undefined })];
  const s = faArchiveSummary({ snapRows: rows, nominalSec: NOM });
  assert.equal(s.liq.snapsWithPos, 1);
  assert.equal(s.liq.last.hl, null, "ноги нет: расстояния до её ликвидации не существует");
  assert.equal(s.liq.min.hl, null);
  assert.equal(s.liq.srcCount.unknown, 0, "несуществующая нога это не «источник неизвестен»");
  assert.equal(s.liq.srcCount.model, 1);
});

test("сделки без позиции в окне: блок запаса пуст, а не заполнен нулями", () => {
  const s = faArchiveSummary({ snapRows: [snap(0, ["BTC"])], nominalSec: NOM });
  assert.equal(s.liq.snapsWithPos, 0);
  assert.equal(s.liq.last, null);
  assert.equal(s.liq.min.gmx, null);
});

test("частоты замера объёма берутся ИЗ ОКНА, и длина окна едет рядом", () => {
  const rows = [snap(0, ["BTC", "ETH"]), gap(0, 60, {}), snap(1440, ["BTC", "ETH"])]; // ровно сутки
  const dec = buildFaDecisionRecord({ t: T0, capitalUsd: 2500, universe: { curves: [], refusals: [] } });
  const tr = buildFaTradeRecord({
    t: T0, event: "open", ageSec: 1,
    opened: { token: "BTC", config: null, strategy: "one", wantUsd: 2500, gotUsd: 2500, leverage: 1, gmx: leg(), hl: null },
    costs: { gmxOpenUsd: 1.5, gmxCloseUsd: 1.5, gmxImpactUsd: 2.5, gmxGasUsd: 1, hlTakerUsd: 0 },
  });
  const s = faArchiveSummary({ snapRows: rows, decRows: [dec], tradeRows: [tr], nominalSec: NOM });
  const m = s.volume.measured;
  assert.equal(m.spanDays, 1, "окно ровно сутки");
  assert.equal(m.markets, 2, "рынков столько, сколько в ПОСЛЕДНЕМ снимке");
  assert.equal(m.pollSec, NOM);
  assert.equal(m.decisionsPerDay, 1);
  assert.equal(m.tradesPerDay, 1);
  assert.equal(m.gapsPerDay, 1);
  assert.equal(m.positionOpen, false);
  assert.ok(s.volume.perDay && s.volume.perDay.total > 0, "замер посчитан");
  assert.ok(s.volume.perDay.snap > s.volume.perDay.dec, "снимки это почти весь объём, и это замер, а не мнение");
});

test("замер объёма не подставляет свои умолчания там, где кормить его нечем", () => {
  // Ни одного снимка: рынков нет, окна нет. `faVolumePerDay` со своими умолчаниями вернул бы
  // ЧУЖОЙ ответ под видом нашего, поэтому здесь обязан быть null.
  const s = faArchiveSummary({ snapRows: [], nominalSec: NOM });
  assert.equal(s.volume.perDay, null);
  assert.equal(s.volume.measured.markets, null);
  assert.equal(s.volume.measured.spanDays, 0);
});

test("окно короче суток замером НЕ считается: частота в сутки была бы умножением на 360", () => {
  // ЖИВОЙ ПРОГОН И НАШЁЛ ЭТО. Четыре минуты ленты с одним решением дали на экране 3.54 МБ в сутки
  // там, где правда около 0.6 МБ: одно событие, поделённое на 0.0028 суток. Оговоркой такое число
  // не чинится, оно просто неверно.
  const rows = [snap(0, ["BTC"]), snap(4, ["BTC"])];
  const dec = buildFaDecisionRecord({ t: T0, capitalUsd: 2500, universe: { curves: [], refusals: [] } });
  const s = faArchiveSummary({ snapRows: rows, decRows: [dec], nominalSec: NOM });
  assert.ok(s.volume.measured.spanDays < 1, "окно действительно короче суток");
  assert.equal(s.volume.perDay, null, "замер не печатается вовсе");
  assert.ok(s.volume.measured.decisionsPerDay > 100, "сама частота при этом посчитана и видна");
});

test("пустой список пропавших рынков различает «никто не исчез» и «ленты не хватило»", () => {
  // ЖИВОЙ ПРОГОН: пять снимков против окна в 60 строк с каждого конца дали на экране «ни одно имя
  // не исчезло». Читатель возвращает пустой список в ОБОИХ случаях, и без этого признака отсутствие
  // наблюдения выглядело на карточке как наблюдение.
  const few = faArchiveSummary({
    snapRows: [snap(0, ["BTC"]), snap(5, ["BTC"])], nominalSec: NOM, warmupRows: 60, tailRows: 60,
  });
  assert.equal(few.vanished.n, 0);
  assert.equal(few.vanished.enough, false, "двух строк против окна в 120 не хватает");
  assert.equal(few.vanished.snaps, 2);

  const many = faArchiveSummary({
    snapRows: [snap(0, ["BTC"]), snap(5, ["BTC"]), snap(10, ["BTC"]), snap(15, ["BTC"])],
    nominalSec: NOM, warmupRows: 2, tailRows: 2,
  });
  assert.equal(many.vanished.enough, true, "четырёх строк против окна в четыре хватает");
  assert.equal(many.vanished.n, 0, "и вот теперь ноль означает «никто не исчез»");
});

test("занятое на диске едет рядом с замером как ФАКТ, а не вместо него", () => {
  const bytes = { snap: 12345, dec: 67, trade: 89, total: 12501 };
  const s = faArchiveSummary({ snapRows: [snap(0, ["BTC"])], nominalSec: NOM, bytes });
  assert.deepEqual(s.volume.onDisk, bytes);
});

test("срок хранения показывается СОСЛАГАТЕЛЬНО и не удаляет ничего", () => {
  const dayKeys = {
    snap: ["2026-01-01", "2026-06-01", "2026-08-30", "2026-09-01"],
    dec: ["2026-08-30", "2026-09-01"],
    trade: ["2026-09-01"],
  };
  const before = JSON.stringify(dayKeys);
  const s = faArchiveSummary({ snapRows: [], dayKeys, todayKey: "2026-09-01" });
  assert.equal(JSON.stringify(dayKeys), before, "входной список суток не тронут");
  assert.deepEqual(s.retention.preview.map((p) => p.keepDays), [...FA_ARCHIVE_KEEP_PREVIEW]);
  const p30 = s.retention.preview.find((p) => p.keepDays === 30);
  assert.deepEqual(p30.expire.snap, ["2026-01-01", "2026-06-01"], "за 30 суток вышли двое старших");
  assert.equal(p30.n, 2);
  const p365 = s.retention.preview.find((p) => p.keepDays === 365);
  assert.equal(p365.n, 0, "при годе хранения за срок не вышло ничего");
  assert.equal(s.retention.oldest.snap, "2026-01-01");
  assert.equal(s.retention.todayKey, "2026-09-01");
});

test("частоты делят на длину СВОЕГО окна: числитель и знаменатель из одного набора суток", () => {
  // Вызывающий читает каждый поток списком СУЩЕСТВУЮЩИХ суточных файлов, а файл сделок заводится
  // только в те сутки, когда сделка была. Тридцать файлов сделок покрывают год, окно снимков
  // тридцать суток, и деление одного на другое завышало «сделок в сутки» в разы.
  const rows = [snap(0, ["BTC"]), snap(1440, ["BTC"])]; // окно ровно сутки
  const old = buildFaTradeRecord({
    t: T0 - 200 * 1440 * MIN, event: "open", ageSec: 1, // сделка ЗА пределами окна снимков
    opened: { token: "BTC", config: null, strategy: "one", wantUsd: 2500, gotUsd: 2500, leverage: 1, gmx: leg(), hl: null },
    costs: { gmxOpenUsd: 1.5, gmxCloseUsd: 1.5, gmxImpactUsd: 2.5, gmxGasUsd: 1, hlTakerUsd: 0 },
  });
  const now = buildFaTradeRecord({
    t: T0 + 60 * MIN, event: "open", ageSec: 1,
    opened: { token: "BTC", config: null, strategy: "one", wantUsd: 2500, gotUsd: 2500, leverage: 1, gmx: leg(), hl: null },
    costs: { gmxOpenUsd: 1.5, gmxCloseUsd: 1.5, gmxImpactUsd: 2.5, gmxGasUsd: 1, hlTakerUsd: 0 },
  });
  const s = faArchiveSummary({ snapRows: rows, tradeRows: [old, now], nominalSec: NOM });
  assert.equal(s.volume.measured.spanDays, 1);
  assert.equal(s.volume.measured.tradesPerDay, 1, "старая сделка вне окна в частоту не входит");
});

test("срок хранения считает СУТКИ, а не пары «поток-сутки»", () => {
  // Одни и те же сутки лежат во всех трёх потоках, и сумма длин трёх списков давала бы тройное
  // число под подписью «вышло бы за срок суток»: больше, чем суток вообще есть.
  const day = ["2026-01-01", "2026-06-01", "2026-09-01"];
  const s = faArchiveSummary({
    snapRows: [], dayKeys: { snap: [...day], dec: [...day], trade: [...day] }, todayKey: "2026-09-01",
  });
  const p30 = s.retention.preview.find((x) => x.keepDays === 30);
  assert.equal(p30.n, 2, "за срок вышли ДВОЕ суток, а не шесть пар");
  assert.deepEqual(p30.expire.snap, ["2026-01-01", "2026-06-01"]);
  assert.deepEqual(p30.expire.dec, ["2026-01-01", "2026-06-01"], "разбивка по потокам при этом цела");
});

test("длинные списки обрезаны потолком, но настоящая длина названа числом", () => {
  const many = Array.from({ length: FA_ARCHIVE_CAP + 5 }, (_, i) => `T${String(i).padStart(2, "0")}`);
  const rows = [snap(0, many), snap(5, many), snap(10, ["T00"]), snap(15, ["T00"])];
  const s = faArchiveSummary({ snapRows: rows, nominalSec: NOM, warmupRows: 2, tailRows: 2 });
  assert.equal(s.vanished.n, FA_ARCHIVE_CAP + 4, "исчезли все, кроме одного");
  assert.equal(s.vanished.markets.length, FA_ARCHIVE_CAP, "показан потолок");
  assert.ok(s.vanished.n > s.vanished.markets.length, "обрезка не имеет права выглядеть полнотой");
  assert.equal(s.cap, FA_ARCHIVE_CAP);
});

test("нечитаемые строки архива едут в ответе, а не глотаются", () => {
  const broken = { snap: 1, dec: 0, trade: 0 };
  const s = faArchiveSummary({ snapRows: [snap(0, ["BTC"])], nominalSec: NOM, broken, daysRead: 3 });
  assert.deepEqual(s.window.broken, broken);
  assert.equal(s.window.daysRead, 3, "суток с файлами, а не календарный отрезок");
});

test("модуль не знает ни времени, ни диска: тот же вход даёт тот же ответ", () => {
  const rows = [snap(0, ["BTC"]), snap(5, ["BTC"])];
  const a = faArchiveSummary({ snapRows: rows, nominalSec: NOM, todayKey: "2026-09-01" });
  const b = faArchiveSummary({ snapRows: rows, nominalSec: NOM, todayKey: "2026-09-01" });
  assert.deepEqual(a, b);
});
