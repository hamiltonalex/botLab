// fa-backfill-bases.test.js - ДОЛИВ БАЗ ФАНДИНГА ИЗ ИНДЕКСАТОРА В ОКНО ВОРОТ БОТА 1.
//
// РЕШЕНИЕ ВЛАДЕЛЬЦА 2026-09-02: расширение запрета 7 на приложение (31.08) снято, и часы окна ворот,
// которых живой опрос не видел, закрываются историей `fundingBalanceOiSnapshots` того же индексатора,
// у которого кадр и так берёт ставки. Ожидание в 28.5 суток от взвода исчезает; ворота, порог и
// коды отказов не меняются ни на бит.
//
// ЧТО ЗДЕСЬ СТЕРЕЖЁТСЯ, И КАЖДОЕ СВОЙСТВО КУПЛЕНО ЦЕНОЙ, КОТОРУЮ НАЗВАЛ ДОКУМЕНТ РЕШЕНИЯ:
//   * живое наблюдение главнее истории и не перезаписывается НИКОГДА, при любом расхождении;
//   * история закрывает только часы без базы, только в окне и только прошлые полные часы;
//   * час, у которого тождество сторон против собственных ставок строки не сошлось, остаётся
//     дырой, а не чужим числом (нули индексатора при живом рынке ловятся именно так);
//   * каждый час помнит происхождение (`fbase_src`), метка переживает запись, чтение и долив ставок,
//     а покрытие делится на живое, долитое и неизвестное: назвать долитое наблюдённым нельзя;
//   * отказ сети кадр не меняет; разбор ответа индексатора проверяется на фикстуре, сеть в тестах
//     не трогается.
//
// ДАННЫЕ СТРОИТ КОНСТРУКТОР `hour()` ИЗ `fa-helpers.mjs`: ставки строки выводятся из потока и баз,
// поэтому история «с теми же базами» проходит тождество по построению, а история с другим
// отношением сторон его ломает. Общий множитель у обеих сторон тождество не ловит, и это граница,
// названная в шапке `potOf`; здесь она показана, а не спрятана.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FA_BASE_SOURCES, applyObservedBases, backfillBases, baseBackfillWindow, baseCoverage,
  emptyBaseJournal, observeBases,
} from "../src/engine/fa/bases.js";
import { resolveBase } from "../src/engine/fa/dilution.js";
import { parseSpreadCsv, toSpreadCsv } from "../src/engine/format.js";
import { HOUR, mergeFrames } from "../src/engine/backfill.js";
import { parseGmxFundingBalanceSnapshots } from "../src/engine/sources.js";
import { GMX_OI_SCALE } from "../src/engine/signs.js";
import { BASE_S, hour } from "./fa-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const B_SHORT = 1e5;
const B_LONG = 1e6;
const POT = 1e-4;

// Окно из `n` часов от BASE_S; `withBase` называет часы, у которых база наблюдена живьём.
const frame = (n, withBase = () => false) =>
  Array.from({ length: n }, (_, h) => hour(h, { pot: POT, bShort: B_SHORT, bLong: B_LONG, bases: withBase(h) }));
const tsOf = (h) => BASE_S + h * 3600;
// История индексатора с ТЕМИ ЖЕ базами, что у конструктора: тождество сходится по построению.
const histFor = (hours, over = {}) => new Map(hours.map((h) => [tsOf(h), { fbase_long: B_LONG, fbase_short: B_SHORT, ...over }]));
const win = (rows) => ({ fromHour: rows[0].tsHour, toHour: rows[rows.length - 1].tsHour });

// ─────────────────────────────────────────────────────────────────────────────
// 1. Слияние: только часы без базы, живое выигрывает, отвергнутое остаётся дырой
// ─────────────────────────────────────────────────────────────────────────────

test("долив заполняет ТОЛЬКО часы без базы и помечает их indexer; нетронутые строки те же объекты", () => {
  const rows = frame(6, (h) => h === 1 || h === 4);
  const r = backfillBases(rows, histFor([0, 1, 2, 3, 4, 5]), win(rows));
  assert.equal(r.filled, 4, "четыре часа без базы закрыты историей");
  assert.equal(r.rejected, 0);
  assert.equal(r.zero, 0);
  assert.equal(r.missing, 0);
  for (const h of [0, 2, 3, 5]) {
    assert.equal(r.rows[h].fbase_long, B_LONG);
    assert.equal(r.rows[h].fbase_short, B_SHORT);
    assert.equal(r.rows[h].fbase_src, "indexer", `час ${h} обязан помнить, что он долит`);
    assert.notEqual(r.rows[h], rows[h], "долитая строка это новый объект: старый не мутируется");
  }
  for (const h of [1, 4]) assert.equal(r.rows[h], rows[h], `час ${h} с базой не тронут: тот же объект`);
  assert.equal(rows.length, r.rows.length, "долив не создаёт и не теряет строк");
});

test("ЖИВОЕ НАБЛЮДЕНИЕ ВЫИГРЫВАЕТ у истории при любом расхождении, и метка live остаётся", () => {
  // Строка без базы получает наблюдение из журнала (метка live), история для того же часа несёт
  // ДРУГОЕ число с тем же отношением сторон, то есть проходит тождество: единственная защита
  // наблюдения это правило «строка с базой сильнее», и оно обязано держаться.
  const j = observeBases(emptyBaseJournal(), { tsHour: tsOf(2), fbaseLongUsd: B_LONG, fbaseShortUsd: B_SHORT }).journal;
  const rows = applyObservedBases(frame(4), j).rows;
  assert.equal(rows[2].fbase_src, "live", "наблюдение из журнала помечено как живое");
  const r = backfillBases(rows, histFor([0, 1, 2, 3], { fbase_long: 7 * B_LONG, fbase_short: 7 * B_SHORT }), win(rows));
  assert.equal(r.rows[2].fbase_long, B_LONG, "живая база не перезаписана долитой");
  assert.equal(r.rows[2].fbase_short, B_SHORT);
  assert.equal(r.rows[2].fbase_src, "live");
  assert.equal(r.rows[2], rows[2], "живая строка не тронута вовсе");
  assert.equal(r.filled, 3, "долиты только три часа без наблюдения");
  // Повторный долив идемпотентен: долитое тоже «строка с базой», история его не двигает.
  const again = backfillBases(r.rows, histFor([0, 1, 2, 3]), win(rows));
  assert.equal(again.filled, 0);
  assert.equal(again.rows, r.rows, "без единого долитого часа возвращается тот же массив");
});

test("час, у которого тождество не сошлось, НЕ заполнен и посчитан отвергнутым: дыра, а не чужое число", () => {
  const rows = frame(3);
  const hist = histFor([0, 1, 2]);
  hist.set(tsOf(1), { fbase_long: 3 * B_LONG, fbase_short: B_SHORT }); // отношение сторон другое
  const r = backfillBases(rows, hist, win(rows));
  assert.equal(r.filled, 2);
  assert.equal(r.rejected, 1, "несошедшийся час посчитан");
  assert.equal(r.missing, 1, "и остался без базы");
  assert.ok(!Number.isFinite(r.rows[1].fbase_long), "отвергнутый час не получил базы");
  assert.equal(r.rows[1].fbase_src ?? null, null);
  assert.equal(r.rows[1], rows[1]);
  // ГРАНИЦА ТОЖДЕСТВА, ПОКАЗАННАЯ, А НЕ СПРЯТАННАЯ: общий множитель у обеих сторон проходит.
  const scaled = backfillBases(frame(1), histFor([0], { fbase_long: 1.02 * B_LONG, fbase_short: 1.02 * B_SHORT }), win(frame(1)));
  assert.equal(scaled.filled, 1, "общий множитель тождество не ловит (шапка potOf), и это названо");
});

test("нулевая база при НУЛЕВОМ потоке записана и посчитана отдельно; ноль при живом рынке отвергнут", () => {
  // Сторона без интереса: поток нулевой, обе ставки нулевые, тождество сверять нечем и оно сходится.
  // Ноль это НАБЛЮДЕНИЕ, а не пропуск: записывается, а отказывает по нему `resolveBase` своим кодом.
  const dead = [hour(0, { pot: 0, bShort: B_SHORT, bLong: B_LONG, bases: false })];
  const r = backfillBases(dead, new Map([[tsOf(0), { fbase_long: B_LONG, fbase_short: 0 }]]), win(dead));
  assert.equal(r.filled, 1, "нулевая база записана");
  assert.equal(r.zero, 1, "и посчитана отдельно");
  assert.equal(r.rows[0].fbase_short, 0);
  assert.equal(r.rows[0].fbase_src, "indexer");
  assert.equal(resolveBase(r.rows[0], "short").reason, "no_base", "отказывает resolveBase своим кодом");
  // Ноль индексатора при ЖИВОМ рынке (ставки ненулевые): тождество не сходится, час остаётся дырой.
  // Это и есть известный дефект индексатора (4.88% записей второго года), превращённый в дыру.
  const live = frame(1);
  const z = backfillBases(live, new Map([[tsOf(0), { fbase_long: B_LONG, fbase_short: 0 }]]), win(live));
  assert.equal(z.filled, 0);
  assert.equal(z.rejected, 1, "ноль при живом рынке отвергнут тождеством");
  assert.equal(z.zero, 0, "и нулевым НЕ считается: он не записан");
});

test("граница окна: часы вне [fromHour, toHour] не трогаются, даже когда история их несёт", () => {
  const rows = frame(6);
  const r = backfillBases(rows, histFor([0, 1, 2, 3, 4, 5]), { fromHour: tsOf(2), toHour: tsOf(3) });
  assert.equal(r.filled, 2);
  for (const h of [0, 1, 4, 5]) assert.equal(r.rows[h], rows[h], `час ${h} вне окна не тронут`);
  for (const h of [2, 3]) assert.equal(r.rows[h].fbase_src, "indexer");
  // Без окна доливать нельзя: границу называет оркестрация, а не история.
  const none = backfillBases(rows, histFor([0, 1, 2, 3, 4, 5]));
  assert.equal(none.filled, 0);
  assert.equal(none.rows, rows);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Окно долива: текущий час пропущен, дальше горизонта не тянется
// ─────────────────────────────────────────────────────────────────────────────

test("окно долива кончается ПРОШЛЫМ ПОЛНЫМ часом и не тянется дальше горизонта", () => {
  const H = 4;
  // Кадр из семи часов, последний это ТЕКУЩИЙ час; базы нет ни у кого.
  const rows = frame(7);
  const nowHour = tsOf(6);
  const w = baseBackfillWindow(rows, { nowHour, horizonH: H });
  assert.equal(w.toHour, nowHour - 3600, "текущий час принадлежит живому опросу и в окно не входит");
  assert.equal(w.fromHour, nowHour - H * 3600, "окно начинается ровно на горизонте");
  assert.equal(w.hours, H, "часов без базы в окне ровно горизонт");
  // Часы с базой в окне не считаются, и границы сжимаются к недостающим.
  const partly = frame(7, (h) => h === 2 || h === 5);
  const p = baseBackfillWindow(partly, { nowHour, horizonH: H });
  assert.equal(p.fromHour, tsOf(3));
  assert.equal(p.toHour, tsOf(4));
  assert.equal(p.hours, 2);
  // Окно покрыто целиком: доливать нечего, значит и сети нет.
  assert.equal(baseBackfillWindow(frame(7, () => true), { nowHour, horizonH: H }), null);
  assert.equal(baseBackfillWindow([], { nowHour, horizonH: H }), null);
  assert.equal(baseBackfillWindow(rows, { nowHour: NaN, horizonH: H }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Метка происхождения: реестр, запись и чтение, долив ставок
// ─────────────────────────────────────────────────────────────────────────────

test("реестр источников: наблюдение ставит live, долив ставит indexer, и других значений нет", () => {
  assert.deepEqual([...FA_BASE_SOURCES], ["live", "indexer"]);
  const j = observeBases(emptyBaseJournal(), { tsHour: tsOf(0), fbaseLongUsd: B_LONG, fbaseShortUsd: B_SHORT }).journal;
  assert.equal(applyObservedBases(frame(1), j).rows[0].fbase_src, "live");
  const rows = frame(1);
  assert.equal(backfillBases(rows, histFor([0]), win(rows)).rows[0].fbase_src, "indexer");
});

test("fbase_src переживает toSpreadCsv и parseSpreadCsv; старый CSV даёт null", () => {
  const base = { ts: "2026-01-01 00:00:00+00:00", f_long: -1e-8, f_short: 2e-8, b_long: 0, b_short: 0, hl_rate: 0, hl_premium: 0 };
  const rows = [
    { ...base, fbase_long: B_LONG, fbase_short: B_SHORT, fbase_src: "indexer" },
    { ...base, ts: "2026-01-01 01:00:00+00:00", fbase_long: B_LONG, fbase_short: B_SHORT, fbase_src: "live" },
    { ...base, ts: "2026-01-01 02:00:00+00:00", fbase_long: B_LONG, fbase_short: B_SHORT },
    { ...base, ts: "2026-01-01 03:00:00+00:00" },
  ];
  const csv = toSpreadCsv(rows);
  assert.ok(csv.split("\n")[0].endsWith(",fbase_src"), "заголовок несёт колонку происхождения");
  const back = parseSpreadCsv(csv);
  assert.equal(back[0].fbase_src, "indexer");
  assert.equal(back[1].fbase_src, "live");
  assert.equal(back[2].fbase_src, null, "база без метки читается как «метки нет», а не как live");
  assert.equal(back[3].fbase_src, null);
  assert.ok(!Number.isFinite(back[3].fbase_long));
  // Кадр ДО появления колонки: значение null у каждой строки, остальные поля целы.
  const old = parseSpreadCsv("ts,f_long,f_short,b_long,b_short,hl_rate,hl_premium,fbase_long,fbase_short\n" +
    "2026-01-01 00:00:00+00:00,1e-8,-2e-8,0,0,0,0,1000000,100000\n");
  assert.equal(old[0].fbase_src, null);
  assert.equal(old[0].fbase_long, 1e6);
  const older = parseSpreadCsv("ts,f_long,f_short,b_long,b_short,hl_rate,hl_premium\n2026-01-01 00:00:00+00:00,1e-8,-2e-8,0,0,0,0\n");
  assert.equal(older[0].fbase_src, null);
  // Мусор вместо слова в файл не идёт: запятая в метке сломала бы разбор всей строки.
  const dirty = parseSpreadCsv(toSpreadCsv([{ ...base, fbase_long: 1, fbase_short: 1, fbase_src: "in,dexer" }]));
  assert.equal(dirty[0].fbase_src, null);
  assert.equal(dirty[0].fbase_short, 1, "соседние клетки не сдвинулись");
});

test("mergeFrames переносит fbase_src вместе с базами: долив ставок не делает долитые часы наблюдёнными", () => {
  const end = 1000 * HOUR;
  const fresh = [{ ts: "a", tsHour: 999 * HOUR, f_long: 9 }]; // историческая строка: ни баз, ни метки
  for (const src of ["indexer", "live"]) {
    const cached = [{ ts: "a", tsHour: 999 * HOUR, f_long: 1, fbase_long: B_LONG, fbase_short: B_SHORT, fbase_src: src }];
    const m = mergeFrames(cached, fresh, 24, end);
    assert.equal(m[0].f_long, 9, "ставка свежая");
    assert.equal(m[0].fbase_long, B_LONG, "база пережила долив");
    assert.equal(m[0].fbase_src, src, `метка «${src}» пережила долив ставок`);
  }
  // Свежая строка со СВОИМИ базами и меткой сохраняет свою: старая метка к ней не относится.
  const cached = [{ ts: "a", tsHour: 999 * HOUR, f_long: 1, fbase_long: 1, fbase_short: 1, fbase_src: "indexer" }];
  const own = [{ ts: "a", tsHour: 999 * HOUR, f_long: 9, fbase_long: 2, fbase_short: 2, fbase_src: "live" }];
  assert.equal(mergeFrames(cached, own, 24, end)[0].fbase_src, "live");
  // Кэш без метки (кадр до колонки) остаётся без метки, а не получает выдуманную.
  const unmarked = [{ ts: "a", tsHour: 999 * HOUR, f_long: 1, fbase_long: B_LONG, fbase_short: B_SHORT }];
  assert.equal(mergeFrames(unmarked, fresh, 24, end)[0].fbase_src, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Покрытие по происхождению
// ─────────────────────────────────────────────────────────────────────────────

test("baseCoverage делит покрытие на live, indexer и unknown, и сумма трёх равна covered", () => {
  // 2 часа живьём (журнал), 3 долитых (история), 1 с базой без метки, 1 без базы вовсе.
  let j = emptyBaseJournal();
  for (const h of [0, 1]) j = observeBases(j, { tsHour: tsOf(h), fbaseLongUsd: B_LONG, fbaseShortUsd: B_SHORT }).journal;
  let rows = applyObservedBases(frame(7, (h) => h === 5), j).rows; // час 5 с базой, но без метки
  rows = backfillBases(rows, histFor([2, 3, 4]), win(rows)).rows; // час 6 истории не имеет
  const cov = baseCoverage(rows, "short");
  assert.equal(cov.hours, 7);
  assert.equal(cov.covered, 6);
  assert.equal(cov.missing, 1);
  assert.equal(cov.coveredLive, 2);
  assert.equal(cov.coveredIndexer, 3);
  assert.equal(cov.coveredUnknown, 1, "база без метки идёт в «неизвестно», а не приписывается живому");
  assert.equal(cov.coveredLive + cov.coveredIndexer + cov.coveredUnknown, cov.covered);
  // Отвергнутый тождеством час не покрыт ни в одном счётчике: годность по-прежнему решает resolveBase.
  const broken = rows.map((r, i) => (i === 2 ? { ...r, fbase_long: r.fbase_long * 3 } : r));
  const bc = baseCoverage(broken, "short");
  assert.equal(bc.covered, 5);
  assert.equal(bc.coveredIndexer, 2, "долитый час с несошедшимся тождеством выпал из долитых, а не перешёл в другой счётчик");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Отказ сети и разбор ответа индексатора (сеть не трогается)
// ─────────────────────────────────────────────────────────────────────────────

test("отказ сети не меняет кадр: пустая история возвращает ТОТ ЖЕ массив, и оркестрация не бросает", () => {
  const rows = frame(5, (h) => h === 0);
  for (const hist of [new Map(), null, undefined]) {
    const r = backfillBases(rows, hist, win(rows));
    assert.equal(r.rows, rows, "кадр не тронут ни на бит");
    assert.equal(r.filled, 0);
    assert.equal(r.missing, 4, "часы без базы остались недостающими и будут запрошены снова");
  }
  // Оркестрация в главном процессе: запрос под try/catch, на отказе одна строка в лог и прежний
  // кадр, исключение наружу не идёт, и долив стоит ПОСЛЕ переноса журнала (живое главнее).
  const main = readFileSync(join(HERE, "..", "src", "main", "main.js"), "utf8");
  const i = main.indexOf("async function faBackfillBases(");
  assert.ok(i > 0, "оркестрация долива не найдена");
  const body = main.slice(i, main.indexOf("\n}\n", i));
  assert.match(body, /try \{\s*hist = await fetchGmxFundingBalanceHistory\(/, "запрос идёт под try");
  assert.match(body, /catch \(e\) \{\s*console\.warn\([^]*?\);\s*return rows;/, "на отказе: строка в лог и прежний кадр");
  assert.ok(!/\bthrow\b/.test(body), "исключение наружу не идёт");
  assert.ok(main.includes("await faBackfillBases(cacheKey, inst, faApplyBases(cacheKey, fetched))"),
    "долив зовётся из ensureFrame сразу после переноса журнала: живое наблюдение главнее");
});

test("разбор ответа индексатора на фикстуре: доллары через baseUsd, мусор не попадает, первый снимок часа выигрывает", () => {
  const at = 1756800000; // 2025-09-02 08:00:00Z, граница часа
  const usd = (x) => (BigInt(Math.round(x)) * BigInt(1e12) * BigInt(1e18)).toString(); // x долларов в точке 1e30
  const fixture = [
    { snapshotTimestamp: at, useOpenInterestInTokensForBalance: true, longFundingBalanceOiUsd: usd(15.2e6), shortFundingBalanceOiUsd: usd(12.7e6) },
    { snapshotTimestamp: at + 1800, useOpenInterestInTokensForBalance: true, longFundingBalanceOiUsd: usd(1), shortFundingBalanceOiUsd: usd(1) }, // тот же час: проигрывает
    { snapshotTimestamp: String(at + 3600), useOpenInterestInTokensForBalance: false, longFundingBalanceOiUsd: usd(0), shortFundingBalanceOiUsd: usd(0.46e6) },
    { snapshotTimestamp: at + 7200, useOpenInterestInTokensForBalance: true, longFundingBalanceOiUsd: "-" + usd(5), shortFundingBalanceOiUsd: usd(5) }, // отрицательная
    { snapshotTimestamp: at + 10800, useOpenInterestInTokensForBalance: true, longFundingBalanceOiUsd: "мусор", shortFundingBalanceOiUsd: usd(5) }, // неконечная
    { snapshotTimestamp: "когда-то", useOpenInterestInTokensForBalance: true, longFundingBalanceOiUsd: usd(5), shortFundingBalanceOiUsd: usd(5) }, // без метки времени
    null,
  ];
  const m = parseGmxFundingBalanceSnapshots(fixture);
  assert.deepEqual([...m.keys()], [at, at + 3600], "в карту попали два часа: отрицательные, неконечные и безвременные отброшены");
  assert.equal(m.get(at).fbase_long, 15.2e6, "масштаб 1e30 снят baseUsd, вторая константа не заводилась");
  assert.equal(m.get(at).fbase_short, 12.7e6);
  assert.equal(m.get(at).useTokens, true, "флаг едет для смока и в кадр не пишется");
  assert.equal(m.get(at + 3600).fbase_long, 0, "ноль это наблюдение и в карту попадает");
  assert.equal(m.get(at + 3600).useTokens, false);
  assert.equal(GMX_OI_SCALE, 1e30, "точка та же, что у открытого интереса в markets/info");
  assert.deepEqual([...parseGmxFundingBalanceSnapshots(null).keys()], []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Изоляция ботов в ОБЕ стороны
// ─────────────────────────────────────────────────────────────────────────────

test("замыкание импортов sources.js не тянет бота 2, а замыкание бота 2 не тянет ни fa/, ни sources.js", () => {
  const closure = (entry) => {
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/^\s*import[^"']*["'](\.[^"']+)["']/gm)) walk(join(dirname(file), m[1]));
    };
    walk(entry);
    // Пути приводятся к прямой косой: на Windows path.join даёт обратную, и проверки по
    // "/fa/dilution.js" не находили бы ничего (поймано Windows-прогоном релиза 0.3.2).
    return [...seen].map((f) => f.split(sep).join("/"));
  };
  const src = closure(join(HERE, "..", "src", "engine", "sources.js"));
  assert.ok(src.some((f) => f.endsWith("/fa/dilution.js")), "масштаб базы берётся у правила разбавления");
  assert.deepEqual(src.filter((f) => f.includes("btcopt")), [], "источники тянут модули бота 2");
  const bot2 = closure(join(HERE, "..", "src", "engine", "btcopt", "engine.js"));
  assert.ok(bot2.length >= 5, "замыкание бота 2 обязано быть непустым");
  assert.deepEqual(bot2.filter((f) => /\/engine\/fa\/|\/engine\/sources\.js$|\/engine\/format\.js$/.test(f)), [],
    "бот 2 не имеет права видеть ни правила бота 1, ни источники, ни формат кадра");
});
