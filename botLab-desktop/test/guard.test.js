// guard.test.js - тесты ЧИСТОЙ части команды охраны (`scripts/guard-lib.mjs`).
//
// ЗАЧЕМ ОНИ ЕСТЬ. Сама `npm run guard` в быстрый цикл не заходит: ей нужна запись в 2.4 ГБ и около
// минуты. Но команда, чьи ветки отказа никогда не исполнялись, это обещание проверки, а не
// проверка: разошедшаяся сумма, недоснятая книга, лишняя книга без эталона и битый файл сумм
// обязаны ЛОВИТЬСЯ, и каждый из этих случаев проверяется здесь отдельно.
//
// САМЫЙ ВАЖНЫЙ ЗДЕСЬ - тест про лишнюю книгу без эталонной строки. Это единственная ветка, где
// охрана могла бы напечатать зелёный итог, ничего не сверив.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseBaselines, checkDigests, parseColumnTable, summarizeColumns, formatVerdict,
} from "../scripts/guard-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const A = "976a03f769541c904b2f56acc97c649896199815a9e52879ed13d555e099bf56";
const B = "70d2fa2c98026572e8b6725b511b56765b7a2be4636957c0a48799a32dea0f3e";

test("файл эталонов репозитория разбирается и описывает ровно две книги", () => {
  const text = readFileSync(join(HERE, "baselines", "books.sha256"), "utf8");
  const { entries, errors } = parseBaselines(text);
  assert.deepEqual(errors, [], "файл эталонов обязан разбираться без ошибок");
  assert.deepEqual([...entries.keys()].sort(), ["base-eng.tsv", "base-ref.tsv"]);
  assert.equal(entries.get("base-ref.tsv"), A);
  assert.equal(entries.get("base-eng.tsv"), B);
});

test("parseBaselines пропускает комментарии и пустые строки", () => {
  const { entries, errors } = parseBaselines(`# шапка\n\n${A}  base-ref.tsv  # хвостовой комментарий\n`);
  assert.deepEqual(errors, []);
  assert.equal(entries.get("base-ref.tsv"), A);
});

test("parseBaselines называет адрес битой строки, а не бросает исключение", () => {
  const { errors } = parseBaselines(`${A}  base-ref.tsv\nмусор\n`);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /строка 2/);
});

test("parseBaselines отвергает обрезанную сумму: она совпала бы ни с чем", () => {
  const { entries, errors } = parseBaselines(`976a03f7...  base-ref.tsv\n`);
  assert.equal(entries.size, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sha256/);
});

test("parseBaselines ловит имя, описанное дважды", () => {
  const { errors } = parseBaselines(`${A}  base-ref.tsv\n${B}  base-ref.tsv\n`);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /дважды/);
});

test("parseBaselines считает пустой файл ошибкой, а не пустым успехом", () => {
  const { entries, errors } = parseBaselines("# только комментарий\n");
  assert.equal(entries.size, 0);
  assert.equal(errors.length, 1);
});

test("checkDigests: обе суммы сошлись", () => {
  const r = checkDigests(new Map([["base-ref.tsv", A], ["base-eng.tsv", B]]),
    new Map([["base-ref.tsv", A], ["base-eng.tsv", B]]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map((x) => x.state), ["сошлась", "сошлась"]);
});

test("checkDigests ловит разошедшуюся сумму и несёт обе стороны для печати", () => {
  const r = checkDigests(new Map([["base-eng.tsv", B]]), new Map([["base-eng.tsv", A]]));
  assert.equal(r.ok, false);
  assert.equal(r.rows[0].state, "разошлась");
  assert.equal(r.rows[0].want, B);
  assert.equal(r.rows[0].got, A);
});

test("checkDigests ловит недоснятую книгу", () => {
  const r = checkDigests(new Map([["base-ref.tsv", A], ["base-eng.tsv", B]]), new Map([["base-ref.tsv", A]]));
  assert.equal(r.ok, false);
  assert.equal(r.rows.find((x) => x.name === "base-eng.tsv").state, "не снята");
});

test("checkDigests ловит книгу БЕЗ эталонной строки: иначе она сверялась бы ни с чем", () => {
  const r = checkDigests(new Map([["base-ref.tsv", A]]),
    new Map([["base-ref.tsv", A], ["base-new.tsv", B]]));
  assert.equal(r.ok, false, "лишняя книга обязана валить охрану, а не проходить молча");
  assert.equal(r.rows.find((x) => x.name === "base-new.tsv").state, "нет эталона");
});

// Настоящий фрагмент отчёта compare-books.mjs по пятилетним книгам (2026-08-29): совпали
// инструмент, входы и залог, разошлись столбцы исполнения хеджа.
const TABLE = `## Столбец за столбцом (в порядке разбора)

| столбец | сошлось | разошлось | максимум расхождения | где |
|---|---|---|---|---|
| инструмент | 84/84 | 0 | - | - |
| лотов | 84/84 | 0 | - | - |
| перекладок | 63/84 | 21 | 3.000 | сделка 50 |
| хедж | 0/84 | 84 | 65.21 | сделка 50 |
| зона | нет в книге | - | - | - |

## Итоги книги (справочно, доказательством не являются)

| столбец | эталон | движок | разница |
|---|---|---|---|
| лотов | 8400.00 | 8400.00 | 0.00 |`;

test("parseColumnTable читает таблицу столбцов и не путает её с таблицей итогов", () => {
  const rows = parseColumnTable(TABLE);
  assert.equal(rows.length, 5, "пять столбцов таблицы разбора, итоги книги сюда не попадают");
  assert.deepEqual(rows[0], { col: "инструмент", ok: 84, total: 84, bad: 0, missing: false });
  assert.deepEqual(rows[3], { col: "хедж", ok: 0, total: 84, bad: 84, missing: false });
  assert.equal(rows[4].missing, true);
});

test("summarizeColumns не засчитывает отсутствующий столбец сошедшимся", () => {
  const s = summarizeColumns(parseColumnTable(TABLE));
  assert.equal(s.matched, 2, "сошлись только инструмент и лотов");
  assert.equal(s.differed, 2);
  assert.equal(s.missing, 1);
  assert.match(s.text, /худший «хедж»/);
});

test("summarizeColumns честно говорит, что таблицу прочитать не удалось", () => {
  const s = summarizeColumns(parseColumnTable("отчёт не той формы"));
  assert.equal(s.total, 0);
  assert.match(s.text, /прочитать не удалось/);
});

test("formatVerdict при успехе называет побайтовое совпадение книг", () => {
  const v = formatVerdict([
    { name: "юнит-тесты", ok: true, detail: "658 пройдено, 0 упало", ms: 15000 },
    { name: "книга эталона", ok: true, detail: "sha сошлась", ms: 16000 },
  ]);
  assert.match(v, /ВСЁ СОШЛОСЬ/);
  assert.match(v, /15\.0 с/);
  assert.doesNotMatch(v, /РАСХОЖДЕНИЕ/);
});

test("formatVerdict при падении называет упавший шаг и что смотреть", () => {
  const v = formatVerdict([
    { name: "юнит-тесты", ok: true, detail: "658 пройдено, 0 упало", ms: 15000 },
    { name: "книга движка", ok: false, detail: "sha разошлась", ms: 19000 },
  ], ["Смотреть первый разошедшийся столбец."]);
  assert.match(v, /РАСХОЖДЕНИЕ: книга движка/);
  assert.match(v, /Смотреть первый разошедшийся столбец\./);
  assert.doesNotMatch(v, /ВСЁ СОШЛОСЬ/);
});
