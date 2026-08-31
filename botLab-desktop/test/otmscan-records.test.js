// otmscan-records.test.js - дописывающий тракт записей (src/engine/store.js, S3c).
// Доказывает: (1) дописывание НЕ переписывает файл - прежние строки на месте после второго вызова;
// (2) резка по суткам UTC даёт отдельные файлы и не смешивает вёдра; (3) пустой массив не создаёт
// файл; (4) оборванная последняя строка (падение посреди append) НЕ роняет читателя, считается в
// broken и не выдаётся за целые данные; (5) чтение отсутствующих суток - пустой результат, не
// исключение; (6) перечисление суток читается с диска и отсортировано; (7) размер на диске виден;
// (8) записи сканера не создают файлов funding-arb и бота 2 (закон Phase 0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendScanRecords,
  readScanRecords,
  listScanRecordDays,
  scanRecordsBytes,
} from "../src/engine/store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "otmscan-rec-"));
const P = "surface";
const D1 = "2026-08-03";
const D2 = "2026-08-04";
const recPath = (dir, day) => join(dir, "scan-records", `${P}-${day}.ndjson`);

test("дописывание не переписывает: прежние строки переживают второй вызов", () => {
  const dir = tmp();
  try {
    assert.equal(appendScanRecords(dir, P, D1, [{ n: "A", d: 0.4 }]), 1);
    assert.equal(appendScanRecords(dir, P, D1, [{ n: "B", d: 0.5 }, { n: "C", d: 0.6 }]), 2);
    const { rows, broken } = readScanRecords(dir, P, [D1]);
    assert.deepEqual(rows.map((r) => r.n), ["A", "B", "C"]);
    assert.equal(broken, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("резка по суткам: разные ключи - разные файлы, чтение объединяет в порядке суток", () => {
  const dir = tmp();
  try {
    appendScanRecords(dir, P, D1, [{ n: "вчера" }]);
    appendScanRecords(dir, P, D2, [{ n: "сегодня" }]);
    assert.ok(existsSync(recPath(dir, D1)) && existsSync(recPath(dir, D2)), "два файла");
    assert.deepEqual(readScanRecords(dir, P, [D1]).rows.map((r) => r.n), ["вчера"]);
    assert.deepEqual(readScanRecords(dir, P, [D1, D2]).rows.map((r) => r.n), ["вчера", "сегодня"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("пустой массив не создаёт файл: пустой прогон не оставляет следа", () => {
  const dir = tmp();
  try {
    assert.equal(appendScanRecords(dir, P, D1, []), 0);
    assert.equal(appendScanRecords(dir, P, D1, null), 0);
    assert.equal(existsSync(recPath(dir, D1)), false);
    assert.deepEqual(listScanRecordDays(dir, P), [], "суток нет");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("оборванный хвост после падения: читатель выживает, потеря названа числом", () => {
  const dir = tmp();
  try {
    appendScanRecords(dir, P, D1, [{ n: "целая-1" }, { n: "целая-2" }]);
    // Имитация падения посреди дописывания: половина JSON без перевода строки.
    appendFileSync(recPath(dir, D1), '{"n":"обор');
    const { rows, broken } = readScanRecords(dir, P, [D1]);
    assert.deepEqual(rows.map((r) => r.n), ["целая-1", "целая-2"], "целые строки прочитаны");
    assert.equal(broken, 1, "потеря посчитана, а не проглочена");
    // И дописывание ПОСЛЕ обрыва не должно ломать уже записанное - портится ровно одна строка.
    appendScanRecords(dir, P, D1, [{ n: "после-обрыва" }]);
    const after = readScanRecords(dir, P, [D1]);
    assert.deepEqual(after.rows.map((r) => r.n), ["целая-1", "целая-2"]);
    assert.equal(after.broken, 1, "склеенная строка одна и она же битая");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("чтение отсутствующих суток и пустого каталога - пусто, без исключений", () => {
  const dir = tmp();
  try {
    const r = readScanRecords(dir, P, [D1, "2020-01-01"]);
    assert.deepEqual(r.rows, []);
    assert.deepEqual(r.files, []);
    assert.equal(r.broken, 0);
    assert.deepEqual(readScanRecords(dir, P, []).rows, []);
    assert.deepEqual(readScanRecords(dir, P, null).rows, []);
    assert.deepEqual(listScanRecordDays(dir, P), []);
    assert.equal(scanRecordsBytes(dir, P), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("перечисление суток читается с диска, отсортировано и не путает префиксы", () => {
  const dir = tmp();
  try {
    appendScanRecords(dir, P, D2, [{ n: "b" }]);
    appendScanRecords(dir, P, D1, [{ n: "a" }]);
    appendScanRecords(dir, "checks", D1, [{ n: "сверка" }]);
    writeFileSync(join(dir, "scan-records", "surface-заметка.txt"), "не запись");
    assert.deepEqual(listScanRecordDays(dir, P), [D1, D2], "только свои сутки, по возрастанию");
    assert.deepEqual(listScanRecordDays(dir, "checks"), [D1]);
    assert.deepEqual(readScanRecords(dir, "checks", [D1]).rows.map((r) => r.n), ["сверка"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("размер на диске виден и растёт вместе с записью", () => {
  const dir = tmp();
  try {
    appendScanRecords(dir, P, D1, [{ n: "x" }]);
    const a = scanRecordsBytes(dir, P);
    assert.ok(a > 0, "ненулевой размер");
    appendScanRecords(dir, P, D1, Array.from({ length: 100 }, (_, i) => ({ n: `y${i}`, v: i })));
    assert.ok(scanRecordsBytes(dir, P) > a, "рост виден");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 0: записи не создают файлов funding-arb и бота 2", () => {
  const dir = tmp();
  try {
    appendScanRecords(dir, P, D1, [{ n: "x" }]);
    const top = readdirSync(dir);
    assert.deepEqual(top, ["scan-records"], "в userData появился ровно один свой каталог");
    for (const forbidden of ["positions.json", "settings.json", "btc-options.json"]) {
      assert.equal(existsSync(join(dir, forbidden)), false, `${forbidden} не создан`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("значения сохраняются точно: null не превращается в 0, вложенность переживает round-trip", () => {
  const dir = tmp();
  try {
    const src = [{ n: "A", b: null, d: -0.3905, meta: { s: "P", tags: [1, 2] } }];
    appendScanRecords(dir, P, D1, src);
    assert.deepEqual(readScanRecords(dir, P, [D1]).rows, src);
    assert.equal(readFileSync(recPath(dir, D1), "utf8").endsWith("\n"), true, "файл кончается переводом строки");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
