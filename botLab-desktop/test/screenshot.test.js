// screenshot.test.js - снимок всей страницы: имя файла, атомарная запись в каталог профиля и
// проводка в главном процессе. `main.js` тянет Electron и под юнит-тест не идёт, поэтому проводка
// проверяется по исходнику, тем же приёмом, что в fa-eval.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { screenshotName, writeScreenshot } from "../src/engine/store.js";
import { isShotShortcut } from "../src/main/shortcuts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "botlab-shot-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("имя снимка: метка UTC без двоеточий и миллисекунд, затем вкладка; мусор во вкладке заменяется словом page", () => {
  const ms = Date.UTC(2026, 8, 3, 5, 7, 9, 456);
  assert.equal(screenshotName(ms, "funding-arb"), "2026-09-03T05-07-09Z-funding-arb.png");
  assert.equal(screenshotName(ms, ""), "2026-09-03T05-07-09Z-page.png");
  assert.equal(screenshotName(ms, null), "2026-09-03T05-07-09Z-page.png");
  assert.equal(screenshotName(ms, "../etc"), "2026-09-03T05-07-09Z-page.png", "путь во вкладке не становится путём в имени");
  assert.equal(screenshotName(ms, "x".repeat(40)), "2026-09-03T05-07-09Z-page.png");
  // Имена сортируются по времени как строки: секунда позже даёт имя строго больше.
  assert.ok(screenshotName(ms + 1000, "home") > screenshotName(ms, "home"));
});

test("writeScreenshot кладёт байты в userData/screenshots, без хвоста .tmp, и возвращает путь файла", () => {
  withDir((dir) => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const path = writeScreenshot(dir, "2026-09-03T05-07-09Z-home.png", png);
    assert.equal(path, join(dir, "screenshots", "2026-09-03T05-07-09Z-home.png"));
    assert.ok(existsSync(path));
    assert.deepEqual([...readFileSync(path)], [...png], "байты записаны как есть");
    assert.deepEqual(readdirSync(join(dir, "screenshots")), ["2026-09-03T05-07-09Z-home.png"], "временного файла после записи нет");
    // Второй снимок ложится рядом, первый не тронут: удаления и перезаписи в складе нет.
    writeScreenshot(dir, "2026-09-03T05-07-10Z-home.png", png);
    assert.equal(readdirSync(join(dir, "screenshots")).length, 2);
  });
});

test("главный процесс: сигнал только вне win32, клавиши в окне, документ целиком через протокол, путь в логе", () => {
  const main = readFileSync(join(HERE, "..", "src", "main", "main.js"), "utf8");
  assert.match(main, /if \(process\.platform !== "win32"\) \{\s*\n\s*process\.on\("SIGUSR2", \(\) => \{ captureFullPage\("SIGUSR2"\); \}\);/,
    "подписка на SIGUSR2 обязана быть за проверкой платформы: на Windows она бросает");
  assert.match(main, /win\.webContents\.on\("before-input-event", \(e, input\) => \{\s*\n\s*if \(!isShotShortcut\(input\)\) return;/,
    "сочетание клавиш ловится в окне, а не глобально, и решает предикат из shortcuts.js");
  assert.match(main, /captureBeyondViewport: true/, "снимается документ целиком, а не видимая часть");
  assert.match(main, /Page\.getLayoutMetrics/, "размер снимка берётся из раскладки документа");
  assert.match(main, /writeScreenshot\(baseDir, screenshotName\(Date\.now\(\), view\)/, "файл кладёт склад, имя строит склад");
  assert.match(main, /console\.log\(`\[shot\] \$\{reason\}: \$\{path\}/, "путь снимка обязан попасть в лог: по нему его и забирают");
  assert.match(main, /console\.error\(`\[shot\] \$\{reason\}: не снялось/, "ошибка снимка это строка лога, а не падение приложения");
  assert.doesNotMatch(main, /globalShortcut/, "глобальных сочетаний клавиш в приложении нет");
});

test("предикат сочетания: Cmd/Ctrl+Shift+S по букве или по физической клавише, без автоповтора и без лишних модификаторов", () => {
  const base = { type: "keyDown", key: "S", code: "KeyS", shift: true, meta: true, control: false, isAutoRepeat: false };
  assert.equal(isShotShortcut(base), true, "macOS: Cmd+Shift+S");
  assert.equal(isShotShortcut({ ...base, meta: false, control: true }), true, "Windows/Linux: Ctrl+Shift+S");
  assert.equal(isShotShortcut({ ...base, key: "ы" }), true, "русская раскладка: буква другая, физическая клавиша та же");
  assert.equal(isShotShortcut({ ...base, key: "s", code: "" }), true, "без кода, по букве");
  assert.equal(isShotShortcut({ ...base, shift: false }), false, "Cmd+S это не снимок");
  assert.equal(isShotShortcut({ ...base, meta: false }), false, "Shift+S это просто буква");
  assert.equal(isShotShortcut({ ...base, type: "keyUp" }), false, "отпускание не считается");
  assert.equal(isShotShortcut({ ...base, isAutoRepeat: true }), false, "автоповтор не плодит снимков");
  assert.equal(isShotShortcut({ ...base, key: "A", code: "KeyA" }), false);
  assert.equal(isShotShortcut(null), false);
});
