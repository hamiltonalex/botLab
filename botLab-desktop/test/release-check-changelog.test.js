// release-check-changelog.test.js - проверка выпуска scripts/check-changelog.mjs.
// Доказывает: (1) при изменённом движке строка «Влияние: нет» роняет выпуск; (2) области, названные
// словами сразу после «Влияние:», его пропускают, даже если дальше в пояснении стоит слово «нет»;
// (3) без изменений в движке «Влияние: нет» законна; (4) раздел без строки «Влияние» роняет выпуск.
// Скрипт читает CHANGELOG.md и историю git рядом с собой, поэтому тест собирает ему маленький
// репозиторий во временной папке: тег v1.0.0 и коммит выпуска 1.0.1 поверх него.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "check-changelog.mjs");
const OLD = "## [1.0.0] - 2026-01-01\n\n**Влияние: нет.**\n";

function checkRelease(impactLine, { engineChanged }) {
  const dir = mkdtempSync(join(tmpdir(), "botlab-changelog-"));
  try {
    // Подпись коммитов и хуки из настроек машины к временному репозиторию отношения не имеют.
    const git = (...args) =>
      execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "scripts"));
    copyFileSync(script, join(dir, "scripts", "check-changelog.mjs"));
    mkdirSync(join(dir, "src", "engine"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.1" }));
    writeFileSync(join(dir, "src", "engine", "rule.js"), "export const x = 1;\n");
    writeFileSync(join(dir, "CHANGELOG.md"), `# Changelog\n\n${OLD}`);
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "--no-verify", "-m", "1.0.0");
    git("tag", "v1.0.0");
    if (engineChanged) writeFileSync(join(dir, "src", "engine", "rule.js"), "export const x = 2;\n");
    writeFileSync(join(dir, "CHANGELOG.md"), `# Changelog\n\n## [1.0.1] - 2026-01-02\n\n${impactLine}\n\n${OLD}`);
    git("add", ".");
    git("commit", "-q", "--no-verify", "-m", "1.0.1");
    return spawnSync(process.execPath, [join(dir, "scripts", "check-changelog.mjs"), "v1.0.1"], { cwd: dir, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("изменённый движок и «Влияние: нет» роняют выпуск", () => {
  const r = checkRelease("**Влияние: нет.** Правка только в текстах.", { engineChanged: true });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /declares "Влияние: нет"/);
});

test("области словами пропускают выпуск, и «нет» в пояснении этому не мешает", () => {
  const r = checkRelease("**Влияние: торговая логика · UI.** Меняется стоп, миграции нет.", { engineChanged: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /engine diff: CHANGED/);
});

test("без изменений в движке «Влияние: нет» законна", () => {
  const r = checkRelease("**Влияние: нет.**", { engineChanged: false });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /engine diff: unchanged/);
});

test("раздел без строки «Влияние» роняет выпуск", () => {
  const r = checkRelease("- **[App]** Правка текста.", { engineChanged: false });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /has no \*\*Влияние\*\* \(impact\) line/);
});
