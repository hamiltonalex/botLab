// otmscan-hist-index-path.test.js - разбор двоичной таблицы мелкого пути индекса
// (src/engine/otmscan/hist-index-path.js).
// Доказывает: (1) круг «записал - прочитал» возвращает те же метки и цены; (2) чужой файл даёт
// НАЗВАННУЮ ошибку, а не молча посчитанный не тот прогон; (3) обрезанный файл называет себя, а не
// падает невнятно; (4) поиск шага находит СТРОГО следующий и не ломается на
// неравноотстоящих шагах, а именно такова таблица: окна без принта в неё не попадают.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readIndexPath, stepAfter, INDEX_PATH_MAGIC } from "../src/engine/otmscan/hist-index-path.js";

// Запись в том же формате, в каком её кладёт scripts/hist-index-path.mjs: метка, число шагов,
// затем по шагу секунда (uint32) и цена (float32).
function encode(steps) {
  const buf = Buffer.alloc(8 + steps.length * 8);
  buf.writeUInt32LE(INDEX_PATH_MAGIC, 0);
  buf.writeUInt32LE(steps.length, 4);
  steps.forEach(([sec, px], i) => {
    buf.writeUInt32LE(sec, 8 + i * 8);
    buf.writeFloatLE(px, 8 + i * 8 + 4);
  });
  return buf;
}

test("круг записи и чтения: метки в миллисекундах, цены на месте", () => {
  const { path, error } = readIndexPath(encode([[1_700_000_000, 61000], [1_700_000_015, 61250.5]]));
  assert.equal(error, null);
  assert.equal(path.n, 2);
  assert.equal(path.ts[0], 1_700_000_000_000, "секунды разворачиваются в миллисекунды");
  assert.equal(path.ts[1], 1_700_000_015_000);
  assert.equal(path.px[0], 61000);
  // float32 хранит 61250.5 точно, а цены округляются до сотых доллара на этом порядке
  assert.ok(Math.abs(path.px[1] - 61250.5) < 0.01);
});

test("чужой файл НАЗЫВАЕТ себя ошибкой, а не читается как таблица", () => {
  // Таблицу подают путём из командной строки, и чужой файл с правдоподобной длиной прочитался
  // бы КАК ТАБЛИЦА: первые четыре байта чужого формата метку BTCP почти наверняка не дадут,
  // но проверять это обязан разбор, а не надежда.
  const { path, error } = readIndexPath(Buffer.from("это не таблица, а текст"), "--fine путь/к/файлу");
  assert.equal(path, null);
  assert.match(error, /--fine путь\/к\/файлу/, "ошибка называет виновника");
  assert.match(error, /BTCP/);
  assert.equal(readIndexPath(null).path, null, "пустой вход тоже отказ, а не падение");
});

test("обрезанный файл называет себя, а не падает невнятно", () => {
  // Заголовок обещает три шага, байт хватает на один: это оборванная закачка.
  //
  // ТИХО ЕЁ НИКОГДА НЕ ЧИТАЛО, и это проверено, а не выведено: Buffer.readUInt32LE сам стережёт
  // границы и на первом же чтении за концом буфера бросает ERR_OUT_OF_RANGE (Node 22.23.2). То
  // есть защищаемся мы не от мусорных цен, а от сообщения «offset out of range, received 16», по
  // которому владелец гадал бы, что именно сломалось. Проверка длины называет виновника: сколько
  // шагов обещано, на сколько хватает байт и какой это файл.
  const full = encode([[1, 10], [2, 20], [3, 30]]);
  const { path, error } = readIndexPath(full.subarray(0, 8 + 8));
  assert.equal(path, null);
  assert.match(error, /обещает 3 шаг/);
});

test("поиск шага: СТРОГО следующий, и шаги неравноотстоящие", () => {
  // Окна без принта в таблицу не попадают вовсе, поэтому арифметика по индексу дала бы не тот шаг.
  const { path } = readIndexPath(encode([[100, 1], [115, 2], [400, 3]])); // разрыв 115 -> 400
  assert.equal(stepAfter(path, 99_000), 0);
  assert.equal(stepAfter(path, 100_000), 1, "ровно на метке берётся СЛЕДУЮЩИЙ шаг, а не этот");
  assert.equal(stepAfter(path, 200_000), 2, "метка внутри разрыва ведёт к шагу за разрывом");
  assert.equal(stepAfter(path, 400_000), 3, "за последним шагом возвращается длина таблицы");
  assert.equal(stepAfter(path, 1e12), 3);
});
