// guard-lib.mjs - ЧИСТАЯ часть команды охраны (`npm run guard`). Ни процессов, ни файлов, ни
// Date.now: всё, что здесь лежит, тесты зовут напрямую.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, И ЭТО НЕ УДОБСТВО РАСКЛАДКИ. Сам `guard.mjs` тратит на прогон около
// минуты и требует записи в 2.4 ГБ, поэтому в `npm test` он не заходит и заходить не должен: он
// пред-мержевый, а быстрый цикл обязан остаться быстрым. Но команда, которая НИКОГДА не проверялась
// на своих же граничных случаях (эталон разошёлся, эталона нет вовсе, файл сумм битый), это
// проверка, про которую никто не знает, умеет ли она падать. Разбор сумм, сведение вердикта и
// чтение таблицы сверки живут поэтому здесь и покрыты тестами по каждой ветке, а `guard.mjs`
// остаётся тонким слоем снабжения: запусти процесс, посчитай sha, отдай результат сюда.

// Сумма sha256 в шестнадцатеричном виде: ровно 64 знака. Проверяется, а не берётся на веру, потому
// что обрезанная на копировании сумма («976a03f7...») совпадала бы ни с чем и читалась бы как
// расхождение правила, хотя дефект был бы в файле эталонов.
const SHA256_RE = /^[0-9a-f]{64}$/;

// parseBaselines(text) - разбор `test/baselines/books.sha256`. Формат тот же, что печатает
// `shasum -a 256`: сумма, пробелы, имя файла. Дополнительно понимаются строки-комментарии с `#`:
// эталон обязан нести рядом с числами СВОЁ ПРОИСХОЖДЕНИЕ (какой записью и какой командой снят),
// иначе через полгода никто не скажет, что именно эти 64 знака описывают.
// Возвращает { entries, errors }. Ошибки НЕ бросаются исключением: битая строка файла эталонов
// должна печататься адресом («строка 7»), а не стектрейсом посреди пятиминутной команды.
export function parseBaselines(text) {
  const entries = new Map();
  const errors = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(\S.*)$/);
    if (!m) { errors.push(`строка ${i + 1}: не «сумма имя», а «${line}»`); continue; }
    const [, sum, name] = m;
    if (!SHA256_RE.test(sum)) { errors.push(`строка ${i + 1}: «${sum}» не похоже на sha256 (нужны 64 знака 0-9a-f)`); continue; }
    if (entries.has(name)) { errors.push(`строка ${i + 1}: «${name}» описан дважды`); continue; }
    entries.set(name, sum);
  }
  if (!entries.size && !errors.length) errors.push("файл эталонов пуст: сверять нечего");
  return { entries, errors };
}

// checkDigests(expected, actual) - сверка снятых сумм с эталонными.
//
// ЛИШНЯЯ КНИГА ЭТО ТОЖЕ РАСХОЖДЕНИЕ, и это не строгость ради строгости. Если охрана снимает книгу,
// которой в файле эталонов нет, она сверяет её НИ С ЧЕМ и печатает зелёный итог; ровно так проверка
// незаметно перестаёт быть проверкой. Поэтому сверяются множества имён, а не только суммы общих.
export function checkDigests(expected, actual) {
  const rows = [];
  for (const [name, want] of expected) {
    const got = actual.get(name) ?? null;
    rows.push({ name, want, got, state: got === null ? "не снята" : got === want ? "сошлась" : "разошлась" });
  }
  for (const [name, got] of actual) {
    if (!expected.has(name)) rows.push({ name, want: null, got, state: "нет эталона" });
  }
  return { ok: rows.every((r) => r.state === "сошлась"), rows };
}

// parseColumnTable(stdout) - чтение таблицы «Столбец за столбцом» из отчёта `compare-books.mjs`.
// Нужна ОДНОЙ строке итога охраны («сколько столбцов сошлось»), сам отчёт печатается целиком и
// читается глазами.
//
// СТОЛБЕЦ «нет в книге» НЕ СЧИТАЕТСЯ СОШЕДШИМСЯ - тот же довод, по которому это правило заведено в
// самом `compare-books.mjs`: книга старого формата иначе даёт зелёный итог про столбец, которого
// не существует ни с одной стороны.
export function parseColumnTable(stdout) {
  const rows = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (!m) continue;
    const [, col, okCell, badCell] = m;
    if (col === "столбец" || /^-+$/.test(col)) continue;
    if (okCell === "нет в книге") { rows.push({ col, ok: 0, total: 0, bad: 0, missing: true }); continue; }
    const fr = okCell.match(/^(\d+)\/(\d+)$/);
    if (!fr || !/^\d+$/.test(badCell)) continue; // таблица итогов книги: другие столбцы, не наша
    rows.push({ col, ok: Number(fr[1]), total: Number(fr[2]), bad: Number(badCell), missing: false });
  }
  return rows;
}

// summarizeColumns(rows) - одна строка про сверку книг для итогового блока.
//
// РАЗОШЕДШИЙСЯ СТОЛБЕЦ ЗДЕСЬ НЕ ОЗНАЧАЕТ ДЕФЕКТА, и путать эти два не надо. Книги снимают ДВЕ
// разные реализации: офлайн-эталон и живой движок. За пять лет у них совпадают инструмент, момент
// входа, момент выхода, число лотов и залог на всех 84 сделках, а расходятся ровно те столбцы, где
// стороны считают по-разному ОСОЗНАННО (движок начисляет фандинг на номинал позиции, как биржа, а
// эталон приближает его дельтой; целые контракты обратного перпа эталон не моделирует вовсе).
// Гейт охраны - это sha каждой книги против СВОЕЙ эталонной суммы; таблица столбцов существует,
// чтобы при расхождении сказать, КАКОЕ правило сдвинулось, а не чтобы требовать совпадения книг.
export function summarizeColumns(rows) {
  const list = rows ?? [];
  const missing = list.filter((r) => r.missing).length;
  const matched = list.filter((r) => !r.missing && r.bad === 0).length;
  const differed = list.filter((r) => !r.missing && r.bad > 0).length;
  const total = list.length;
  if (!total) return { total, matched, differed, missing, text: "таблицу столбцов прочитать не удалось" };
  const worst = list.filter((r) => !r.missing && r.bad > 0).sort((a, b) => b.bad - a.bad)[0] ?? null;
  const tail = differed ? `, разошлись ${differed} (худший «${worst.col}»: ${worst.bad} из ${worst.total})` : "";
  const miss = missing ? `, нет в книге ${missing}` : "";
  return { total, matched, differed, missing, text: `столбцов ${total}: сошлись ${matched}${tail}${miss}` };
}

// formatVerdict(steps, advice) - итоговый блок. Отдельной ЧИСТОЙ функцией, потому что смысл команды
// в этих строках: охрана, которая упала невнятно, стоит ровно столько же, сколько не запущенная.
//   steps - [{ name, ok, detail, ms }] в порядке исполнения; ms необязательно;
//   advice - что смотреть при падении (строки).
export function formatVerdict(steps, advice = []) {
  const list = steps ?? [];
  const w = Math.max(0, ...list.map((s) => s.name.length));
  const out = ["", "# Итог охраны", ""];
  for (const s of list) {
    const mark = s.ok === null ? "   " : s.ok ? " + " : " ! ";
    const time = Number.isFinite(s.ms) ? `  ${(s.ms / 1000).toFixed(1)} с` : "";
    out.push(`${mark}${s.name.padEnd(w)}  ${s.detail}${time}`);
  }
  out.push("");
  const failed = list.filter((s) => s.ok === false);
  if (!failed.length) {
    out.push("ВСЁ СОШЛОСЬ. Все книги побайтово те же, что в test/baselines/books.sha256, то есть");
    out.push("поведение обоих боевых трактов не сдвинулось.");
  } else {
    out.push(`РАСХОЖДЕНИЕ: ${failed.map((s) => s.name).join(", ")}.`);
    for (const line of advice) out.push(line);
  }
  return out.join("\n");
}
