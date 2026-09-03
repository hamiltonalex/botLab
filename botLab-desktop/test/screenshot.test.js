// screenshot.test.js - снимок всей страницы: имя файла, атомарная запись в каталог профиля и
// проводка в главном процессе. `main.js` тянет Electron и под юнит-тест не идёт, поэтому проводка
// проверяется по исходнику, тем же приёмом, что в fa-eval.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { screenshotName, writeScreenshot, writeScreenshotTo } from "../src/engine/store.js";
import { isShotShortcut } from "../src/main/shortcuts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "botlab-shot-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("имя снимка: префикс botlab, метка UTC без двоеточий и миллисекунд, затем вкладка; мусор во вкладке заменяется словом page", () => {
  const ms = Date.UTC(2026, 8, 3, 5, 7, 9, 456);
  assert.equal(screenshotName(ms, "funding-arb"), "botlab-2026-09-03T05-07-09Z-funding-arb.png");
  assert.equal(screenshotName(ms, ""), "botlab-2026-09-03T05-07-09Z-page.png");
  assert.equal(screenshotName(ms, null), "botlab-2026-09-03T05-07-09Z-page.png");
  assert.equal(screenshotName(ms, "../etc"), "botlab-2026-09-03T05-07-09Z-page.png", "путь во вкладке не становится путём в имени");
  assert.equal(screenshotName(ms, "x".repeat(40)), "botlab-2026-09-03T05-07-09Z-page.png");
  assert.doesNotMatch(screenshotName(ms, "home"), /:/, "двоеточий в имени нет: Windows их не терпит");
  // Имена сортируются по времени как строки: секунда позже даёт имя строго больше.
  assert.ok(screenshotName(ms + 1000, "home") > screenshotName(ms, "home"));
});

test("writeScreenshot кладёт байты в userData/screenshots, без хвоста .tmp, и возвращает путь файла", () => {
  withDir((dir) => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const path = writeScreenshot(dir, "botlab-2026-09-03T05-07-09Z-home.png", png);
    assert.equal(path, join(dir, "screenshots", "botlab-2026-09-03T05-07-09Z-home.png"));
    assert.ok(existsSync(path));
    assert.deepEqual([...readFileSync(path)], [...png], "байты записаны как есть");
    assert.deepEqual(readdirSync(join(dir, "screenshots")), ["botlab-2026-09-03T05-07-09Z-home.png"], "временного файла после записи нет");
    // Второй снимок ложится рядом, первый не тронут: удаления и перезаписи в складе нет.
    writeScreenshot(dir, "botlab-2026-09-03T05-07-10Z-home.png", png);
    assert.equal(readdirSync(join(dir, "screenshots")).length, 2);
  });
});

test("writeScreenshotTo кладёт файл в НАЗВАННЫЙ каталог (папка загрузок), создавая его при нужде", () => {
  withDir((dir) => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
    const path = writeScreenshotTo(join(dir, "Downloads"), "botlab-2026-09-03T05-07-09Z-home.png", png);
    assert.equal(path, join(dir, "Downloads", "botlab-2026-09-03T05-07-09Z-home.png"));
    assert.deepEqual([...readFileSync(path)], [...png]);
    assert.deepEqual(readdirSync(join(dir, "Downloads")), ["botlab-2026-09-03T05-07-09Z-home.png"], "без .tmp");
    assert.ok(!existsSync(join(dir, "screenshots")), "каталог профиля при этом не создаётся");
  });
});

test("главный процесс: сигнал только вне win32, клавиши в окне, документ целиком через протокол, путь в логе", () => {
  const main = readFileSync(join(HERE, "..", "src", "main", "main.js"), "utf8");
  assert.match(main, /if \(process\.platform !== "win32"\) \{\s*\n\s*process\.on\("SIGUSR2", \(\) => \{ captureFullPage\("SIGUSR2", "profile"\); \}\);/,
    "подписка на SIGUSR2 обязана быть за проверкой платформы (на Windows она бросает) и класть файл в ПРОФИЛЬ: папки загрузок по SSH на macOS не видно");
  assert.match(main, /captureFullPage\("клавиши", "downloads"\)/, "клавиши это человек за машиной: файл в папку загрузок");
  assert.match(main, /ipcMain\.handle\("ui:screenshot", async \(\) => \(await captureFullPage\("кнопка", "downloads"\)\)/,
    "кнопка шапки идёт через IPC и кладёт файл в папку загрузок");
  assert.match(main, /app\.getPath\("downloads"\)/, "папка загрузок берётся у платформы, а не собирается из HOME");
  assert.match(main, /if \(!path\) path = writeScreenshot\(baseDir, name, png\);/, "если в загрузки не записалось, файл уходит в профиль, а не теряется");
  assert.match(main, /if \(typeof p !== "string" \|\| !shotPaths\.has\(p\)\) return \{ ok: false \};\s*\n\s*shell\.showItemInFolder\(p\);/,
    "в оболочку уходят только пути, которые выдал сам снимок");
  assert.match(main, /win\.webContents\.on\("before-input-event", \(e, input\) => \{\s*\n\s*if \(!isShotShortcut\(input\)\) return;/,
    "сочетание клавиш ловится в окне, а не глобально, и решает предикат из shortcuts.js");
  assert.match(main, /captureBeyondViewport: true/, "снимается документ целиком, а не видимая часть");
  assert.match(main, /Page\.getLayoutMetrics/, "размер снимка берётся из раскладки документа");
  assert.match(main, /const name = screenshotName\(Date\.now\(\), view\);/, "имя строит склад");
  assert.match(main, /path = writeScreenshotTo\(downloads, name, png\);/, "в папку загрузок файл кладёт склад");
  assert.match(main, /console\.log\(`\[shot\] \$\{reason\}: \$\{path\}/, "путь снимка обязан попасть в лог: по нему его и забирают");
  assert.match(main, /console\.error\(`\[shot\] \$\{reason\}: не снялось/, "ошибка снимка это строка лога, а не падение приложения");
  assert.doesNotMatch(main, /globalShortcut/, "глобальных сочетаний клавиш в приложении нет");
});

test("мост и рендерер: кнопка в шапке, уведомление с путём, ключи в обоих словарях", async () => {
  const pre = readFileSync(join(HERE, "..", "src", "main", "preload.cjs"), "utf8");
  assert.match(pre, /screenshot: \(\) => ipcRenderer\.invoke\("ui:screenshot"\)/);
  assert.match(pre, /showInFolder: \(p\) => ipcRenderer\.invoke\("ui:showInFolder", p\)/);
  assert.match(pre, /onShot: \(cb\) => ipcRenderer\.on\("ui:shot"/, "о снимке по клавишам или сигналу рендерер узнаёт пушем");
  const html = readFileSync(join(HERE, "..", "src", "renderer", "index.html"), "utf8");
  assert.match(html, /<button class="shot-btn" id="shotBtn" type="button"[^>]*data-i18n-title="chrome\.shot\.title"/, "кнопка снимка в шапке");
  assert.match(html, /<header class="topbar">[\s\S]*id="shotBtn"[\s\S]*<\/header>/, "кнопка стоит в постоянной шапке, а не внутри вида одного бота");
  assert.match(html, /id="shotToast"[^>]*role="status"[^>]*hidden/, "уведомление о снимке скрыто, пока снимка не было");
  assert.match(html, /window\.ui\.screenshot\(\)/, "кнопка зовёт мост, а не снимает сама");
  assert.match(html, /window\.ui\.showInFolder\(lastPath\)/);
  assert.doesNotMatch(html, /captureScreenshot|webContents/, "в рендерере нет ни протокола, ни главного процесса");
  const { default: ru } = await import("../src/renderer/locales/ru.js").catch(() => ({ default: null }));
  for (const loc of ["ru", "en"]) {
    const src = readFileSync(join(HERE, "..", "src", "renderer", "locales", `${loc}.js`), "utf8");
    for (const k of ["chrome.shot.aria", "chrome.shot.title", "chrome.shot.done", "chrome.shot.doneProfile", "chrome.shot.fail", "chrome.shot.show", "chrome.shot.close"]) {
      assert.ok(src.includes(`'${k}':`), `${loc}: нет ключа ${k}`);
    }
    assert.match(src, /'chrome\.shot\.done': '[^']*\{path\}/, `${loc}: подпись снимка обязана нести путь`);
  }
  void ru;
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
