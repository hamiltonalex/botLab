// fa-bases.test.js - НАКОПЛЕНИЕ НАБЛЮДЁННЫХ БАЗ ФАНДИНГА ВПЕРЁД (fa/bases.js).
//
// ЧТО ЗДЕСЬ СТЕРЕЖЁТСЯ И ПОЧЕМУ ЭТО БЛОКЕР, А НЕ УДОБСТВО. Без базы в часовой строке правило входа
// обнуляет доход КАЖДОГО часа получения (замер коммита ec6e638: фактор 0 на старом кадре против
// 0.995 на кадре с базами), то есть автомат не входит в сделку никогда. Колонки в кадр добавлены
// раньше; здесь проверяется единственный источник, который имеет право их наполнять.
//
// ГЛАВНОЕ СВОЙСТВО, РАДИ КОТОРОГО ЖУРНАЛ ОТДЕЛЁН ОТ КАДРА: частичная строка текущего часа в кадре
// сломала бы долив (он стартует с «последний час плюс час») и проверку свежести (кадр выглядел бы
// вечно свежим). Оба дефекта тихие, и оба здесь выражены проверками.

import test from "node:test";
import assert from "node:assert/strict";
import {
  FA_BASE_JOURNAL_HOURS, FA_BASE_JOURNAL_VERSION,
  applyObservedBases, baseCoverage, emptyBaseJournal, normalizeBaseJournal, observeBases,
} from "../src/engine/fa/bases.js";
import { hour } from "./fa-helpers.mjs";

const H0 = 486223; // эпоха-час, произвольный, но фиксированный

// ─────────────────────────────────────────────────────────────────────────────
// 1. Наблюдение часа
// ─────────────────────────────────────────────────────────────────────────────

test("ПЕРВОЕ наблюдение часа выигрывает, поэтому журнал дописывается, а не переписывается", () => {
  let j = emptyBaseJournal();
  const a = observeBases(j, { tsHour: H0, fbaseLongUsd: 2e6, fbaseShortUsd: 1e6 });
  assert.equal(a.changed, true);
  j = a.journal;
  // Тот же час на следующем опросе: наблюдение то же по смыслу, писать нечего.
  const b = observeBases(j, { tsHour: H0, fbaseLongUsd: 9e6, fbaseShortUsd: 8e6 });
  assert.equal(b.changed, false, "признак изменения нужен писателю: без него кадр писался бы каждый опрос ни за что");
  assert.deepEqual(b.journal.obs, [[H0, 2e6, 1e6]], "значение часа не переписывается");
  // Следующий час это новое наблюдение.
  const c = observeBases(b.journal, { tsHour: H0 + 1, fbaseLongUsd: 3e6, fbaseShortUsd: 1.5e6 });
  assert.equal(c.changed, true);
  assert.equal(c.journal.obs.length, 2);
});

test("непригодное наблюдение НЕ записывается, а ноль записывается: это разные сообщения", () => {
  const j = emptyBaseJournal();
  for (const bad of [
    { tsHour: NaN, fbaseLongUsd: 1, fbaseShortUsd: 1 },
    { tsHour: H0, fbaseLongUsd: NaN, fbaseShortUsd: 1 },
    { tsHour: H0, fbaseLongUsd: 1, fbaseShortUsd: undefined },
    { tsHour: H0, fbaseLongUsd: -1, fbaseShortUsd: 1 },
  ]) {
    assert.equal(observeBases(j, bad).changed, false, `${JSON.stringify(bad)} не наблюдение`);
  }
  // Ноль это НАБЛЮДЕНИЕ («интереса стороны нет»), а не пропуск, и отказывать по нему будет
  // `resolveBase` своим кодом, а не молчание журнала.
  assert.equal(observeBases(j, { tsHour: H0, fbaseLongUsd: 5e6, fbaseShortUsd: 0 }).changed, true);
});

test("журнал ограничен неделей часов: это буфер до появления строки, а не второй архив", () => {
  let j = emptyBaseJournal();
  for (let i = 0; i < FA_BASE_JOURNAL_HOURS + 40; i += 1) {
    j = observeBases(j, { tsHour: H0 + i, fbaseLongUsd: 2e6, fbaseShortUsd: 1e6 }).journal;
  }
  assert.equal(j.obs.length, FA_BASE_JOURNAL_HOURS);
  assert.equal(j.obs[0][0], H0 + 40, "обрезается ГОЛОВА: свежие часы ещё ждут своих строк");
  assert.equal(j.obs[j.obs.length - 1][0], H0 + FA_BASE_JOURNAL_HOURS + 39);
});

test("чужая версия и битая запись дают ПУСТОЙ журнал, а не исключение", () => {
  assert.deepEqual(normalizeBaseJournal(null).obs, []);
  assert.deepEqual(normalizeBaseJournal({ v: FA_BASE_JOURNAL_VERSION + 1, obs: [[1, 2, 3]] }).obs, []);
  assert.deepEqual(normalizeBaseJournal("мусор").obs, []);
  // Отдельная битая строка выбрасывается, годные остаются: терять весь буфер из-за одной строки
  // дороже, чем потерять её.
  const j = normalizeBaseJournal({ v: FA_BASE_JOURNAL_VERSION, obs: [[H0, 1, 2], "нет", [NaN, 1, 2], [H0 - 1, 3, 4]] });
  assert.deepEqual(j.obs, [[H0 - 1, 3, 4], [H0, 1, 2]], "и порядок восстанавливается по часу");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Перенос в строки кадра
// ─────────────────────────────────────────────────────────────────────────────

const rowAt = (tsHour, extra = {}) => ({ tsHour, f_long: -1e-8, f_short: 2e-8, b_long: 0, b_short: 0, hl_rate: 0, ...extra });

test("наблюдение переносится в строку ТОГО ЖЕ часа, и лишних строк не появляется", () => {
  const j = observeBases(emptyBaseJournal(), { tsHour: H0, fbaseLongUsd: 2e6, fbaseShortUsd: 1e6 }).journal;
  const rows = [rowAt(H0 - 1), rowAt(H0), rowAt(H0 + 1)];
  const r = applyObservedBases(rows, j);
  assert.equal(r.applied, 1);
  assert.equal(r.rows.length, 3, "перенос НЕ создаёт строк: частичная строка сломала бы долив и свежесть кадра");
  assert.equal(r.rows[1].fbase_long, 2e6);
  assert.equal(r.rows[1].fbase_short, 1e6);
  assert.ok(!Number.isFinite(r.rows[0].fbase_long), "соседние часы не трогаются");
});

test("перенос ИДЕМПОТЕНТЕН и не трогает строки, у которых база уже есть", () => {
  const j = observeBases(emptyBaseJournal(), { tsHour: H0, fbaseLongUsd: 2e6, fbaseShortUsd: 1e6 }).journal;
  const rows = [rowAt(H0)];
  const once = applyObservedBases(rows, j);
  const twice = applyObservedBases(once.rows, j);
  assert.equal(twice.applied, 0, "повторное применение ничего не двигает, значит писать на диск нечего");
  // Наблюдение КАДРА сильнее журнала: журнал это буфер до появления строки, а не второй источник.
  const already = applyObservedBases([rowAt(H0, { fbase_long: 7e6, fbase_short: 5e6 })], j);
  assert.equal(already.applied, 0);
  assert.equal(already.rows[0].fbase_long, 7e6);
  // Пустой журнал возвращает ТЕ ЖЕ строки: копия кадра на каждый опрос это 8760 объектов ни за что.
  assert.equal(applyObservedBases(rows, emptyBaseJournal()).rows, rows);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Покрытие окна
// ─────────────────────────────────────────────────────────────────────────────

test("годность часа определяет resolveBase, а не собственная проверка покрытия", () => {
  // Конструктор `hour` держит тождество сторон по построению, поэтому час с базами годен.
  const good = [hour(0, { pot: 1e-4, bShort: 1e5, bLong: 1e6 }), hour(1, { pot: 1e-4, bShort: 1e5, bLong: 1e6 })];
  assert.deepEqual(baseCoverage(good, "short"), { hours: 2, covered: 2, missing: 0, fraction: 1 });
  // Час без баз не покрыт, и это ровно тот час, на котором правило входа обнулит доход.
  const mixed = [...good, hour(2, { pot: 1e-4, bShort: 1e5, bLong: 1e6, bases: false })];
  const cov = baseCoverage(mixed, "short");
  assert.equal(cov.covered, 2);
  assert.equal(cov.missing, 1);
  assert.ok(Math.abs(cov.fraction - 2 / 3) < 1e-12);
  // Час, где база нашей стороны есть, а тождество сторон НЕ сошлось, тоже не покрыт: база пришла
  // не та, и считать по ней разбавление значит считать по чужому числу.
  const broken = [{ ...good[0], fbase_long: good[0].fbase_long * 3 }];
  assert.equal(baseCoverage(broken, "short").covered, 0, "несошедшееся тождество это НЕ покрытый час");
  // Пустое окно это ноль покрытия, а не единица: делить нечего, и молчаливое «всё хорошо» здесь
  // означало бы вход по пустым данным.
  assert.equal(baseCoverage([], "short").fraction, 0);
});
