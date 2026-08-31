// store.js - disk persistence for the forward paper test. CRITICAL: paper positions + full
// accrual ledgers survive app restarts so a forward test resumes. Trailing history is cached as
// CSVs (same layout as spread_cache) so restarts don't refetch the whole window.
//
// All writes are atomic (write tmp -> rename) to avoid corruption on crash/quit. baseDir is
// app.getPath('userData') in production; a temp dir in tests.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSpreadCsv, toSpreadCsv } from "./format.js";

const ensureDir = (dir) => {
  mkdirSync(dir, { recursive: true });
  return dir;
};

function atomicWrite(path, text) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

const positionsPath = (b) => join(b, "positions.json");
const settingsPath = (b) => join(b, "settings.json");
// NOT "cache": userData is shared with Chromium, and on the case-insensitive filesystems Electron
// ships on (macOS APFS default, Windows NTFS) join(userData, "cache") IS Chromium's own "Cache"
// directory - its cache backend purges foreign files there, so the CSV frames silently vanished on
// every boot and each start refetched the full trailing window (audit #3).
const FRAME_CACHE_DIR = "frame-cache";
const cacheDir = (b) => ensureDir(join(b, FRAME_CACHE_DIR));
const cachePath = (b, key) => join(cacheDir(b), `${key}.csv`);
const legacyCachePath = (b, key) => join(b, "cache", `${key}.csv`);

// ---- paper positions (the forward-test state) ----
// A corrupted positions.json is QUARANTINED (renamed .corrupt-<ts>) rather than silently replaced,
// so a forward test's ledger is never destroyed by one bad write (audit M32).
export function loadPositions(baseDir) {
  ensureDir(baseDir);
  const p = positionsPath(baseDir);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    try {
      renameSync(p, `${p}.corrupt-${Date.now()}`);
    } catch {}
    return [];
  }
}
export function savePositions(baseDir, positions) {
  ensureDir(baseDir);
  atomicWrite(positionsPath(baseDir), JSON.stringify(positions, null, 2));
}

// ---- UI/settings (capital, leverage, selection, cost overrides, poll interval) ----
// Whether a settings.json already exists - lets the post-update changelog logic tell a fresh install
// (no file) apart from an upgrade (file present, §8.3). Read-only: never creates the file.
export function hasSettings(baseDir) {
  return existsSync(settingsPath(baseDir));
}
export function loadSettings(baseDir) {
  ensureDir(baseDir);
  return readJson(settingsPath(baseDir), {});
}
export function saveSettings(baseDir, settings) {
  ensureDir(baseDir);
  atomicWrite(settingsPath(baseDir), JSON.stringify(settings, null, 2));
}

// ---- per-bot state + settings (isolated modules; ADDITIVE) ----
// A second bot (e.g. "btc-options") gets its OWN files so it never collides with funding-arb's
// positions.json/settings.json - those are never read or written here (zero migration risk to the
// working bot). Files: userData/<id>.json (paper state + cumulative ledger) and
// userData/<id>-settings.json. Same atomic-write + tolerant-read discipline as above.
const botStatePath = (b, id) => join(b, `${id}.json`);
const botSettingsPath = (b, id) => join(b, `${id}-settings.json`);
export function loadBotState(baseDir, id) {
  ensureDir(baseDir);
  return readJson(botStatePath(baseDir, id), null); // null = "no state yet" (first run)
}
export function saveBotState(baseDir, id, st) {
  ensureDir(baseDir);
  atomicWrite(botStatePath(baseDir, id), JSON.stringify(st, null, 2));
}
// S2 (OTM-сканер, план §7 случай 17): строгая загрузка с КАРАНТИНОМ битого JSON - файл
// переименовывается в .corrupt-<ts>, чтобы журнал сигналов не был уничтожен одной плохой записью
// (закон loadPositions, аудит M32). loadBotState() выше сохраняет терпимое поведение бота 2.
export function loadBotStateQuarantine(baseDir, id, nowMs = Date.now()) {
  ensureDir(baseDir);
  const p = botStatePath(baseDir, id);
  if (!existsSync(p)) return { state: null, corrupt: false };
  try {
    return { state: JSON.parse(readFileSync(p, "utf8")), corrupt: false };
  } catch {
    try {
      renameSync(p, `${p}.corrupt-${nowMs}`);
    } catch {}
    return { state: null, corrupt: true };
  }
}
export function loadBotSettings(baseDir, id) {
  ensureDir(baseDir);
  return readJson(botSettingsPath(baseDir, id), {});
}
export function saveBotSettings(baseDir, id, s) {
  ensureDir(baseDir);
  atomicWrite(botSettingsPath(baseDir, id), JSON.stringify(s, null, 2));
}

// ---- append-only NDJSON records (S3c, слой записи сканера) ----
// ПОЧЕМУ ОТДЕЛЬНЫЙ ТРАКТ, А НЕ КЛЮЧ В ТЕЛЕМЕТРИИ. saveBotState переписывает файл ЦЕЛИКОМ (write
// tmp + rename). Для суточных вёдер это правильно - они маленькие и должны быть атомарны. Но записи
// поверхности это ~82 КБ на снимок и десятки мегабайт за прогон: перезапись целого файла на каждом
// флаше дала бы квадратичную стоимость и растущие паузы. Поэтому здесь дописывание в конец.
//
// ЦЕНА ВЫБОРА, НАЗВАННАЯ ЯВНО: append не атомарен. Падение процесса посреди записи оставляет
// оборванную последнюю строку - поэтому читатель обязан её пережить, а не бросить. Ровно одна
// строка в конце файла может пострадать, и она считается в `broken`, а не проглатывается молча
// (та же дисциплина, что карантин в loadBotStateQuarantine: данные не уничтожаются одной плохой
// записью, но и не выдаются за целые).
//
// Файлы режутся по суткам UTC: <baseDir>/scan-records/<prefix>-<YYYY-MM-DD>.ndjson. Тот же ключ
// суток, что у вёдер телеметрии, поэтому запись и статистика соединяются без переводов времени.
const RECORDS_DIR = "scan-records";
const recordsDir = (b) => ensureDir(join(b, RECORDS_DIR));
const recordPath = (b, prefix, dayKey) => join(recordsDir(b), `${prefix}-${dayKey}.ndjson`);

// Дописать строки. rows - массив объектов; пустой массив НЕ создаёт файл (пустой прогон не должен
// оставлять следов, по которым отчёт решит, что данные были). Возвращает число записанных строк.
export function appendScanRecords(baseDir, prefix, dayKey, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(recordPath(baseDir, prefix, dayKey), text);
  return rows.length;
}

// Прочитать записи за перечисленные сутки. Возвращает { rows, broken, files } - broken это число
// нечитаемых строк (оборванный хвост после падения); отчёт обязан его показать.
export function readScanRecords(baseDir, prefix, dayKeys) {
  const rows = [];
  const files = [];
  let broken = 0;
  for (const dayKey of dayKeys ?? []) {
    const p = recordPath(baseDir, prefix, dayKey);
    if (!existsSync(p)) continue;
    files.push(p);
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        broken += 1;
      }
    }
  }
  return { rows, broken, files };
}

// Какие сутки записаны для префикса - чтобы отчёт не угадывал диапазон, а читал его с диска.
export function listScanRecordDays(baseDir, prefix) {
  const dir = join(baseDir, RECORDS_DIR);
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.ndjson$`);
  return readdirSync(dir)
    .map((f) => re.exec(f)?.[1])
    .filter(Boolean)
    .sort();
}

// Размер записей на диске в байтах - для панели честности и для лога прогона: рост файла обязан
// быть видимым оператору, а не сюрпризом на 60-м часу.
export function scanRecordsBytes(baseDir, prefix) {
  const dir = join(baseDir, RECORDS_DIR);
  if (!existsSync(dir)) return 0;
  const re = new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.ndjson$`);
  let total = 0;
  for (const f of readdirSync(dir)) {
    if (!re.test(f)) continue;
    try {
      total += statSync(join(dir, f)).size;
    } catch {}
  }
  return total;
}

// ---- журнал наблюдённых баз фандинга бота 1 (fa/bases.js) ----
// ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ КОЛОНКА В КАДРЕ. Кадр приходит из ИСТОРИЧЕСКОГО запроса и отстаёт на
// час-два, поэтому строки текущего часа в нём ещё нет, а дописать её частичной нельзя: долив
// стартует с «последний час кадра плюс час» и ставки этого часа не были бы получены никогда, а
// проверка свежести считала бы кадр вечно свежим. Наблюдение живёт здесь и переносится в строку
// тогда, когда строка появилась.
//
// Файл крошечный (неделя часов на инструмент) и меняется не чаще раза в час: первое наблюдение
// часа выигрывает, значит писать нечего, пока час не сменился.
const BASES_DIR = "fa-bases";
const basesDir = (b) => ensureDir(join(b, BASES_DIR));
const basesPath = (b, key) => join(basesDir(b), `${key}.json`);

export function loadFaBases(baseDir, key) {
  ensureDir(baseDir);
  return readJson(basesPath(baseDir, key), null); // null = наблюдений ещё не было
}
export function saveFaBases(baseDir, key, journal) {
  ensureDir(baseDir);
  atomicWrite(basesPath(baseDir, key), JSON.stringify(journal));
}

// ---- trailing-history CSV cache (per instrument key) ----
export function readCache(baseDir, key) {
  let p = cachePath(baseDir, key);
  // one-time migration read: a frame written by an older build into the legacy "cache/" location
  // (if Chromium has not purged it yet) is still served; the next writeCache lands in frame-cache/.
  if (!existsSync(p)) p = legacyCachePath(baseDir, key);
  if (!existsSync(p)) return null;
  try {
    return parseSpreadCsv(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
export function writeCache(baseDir, key, rows) {
  atomicWrite(cachePath(baseDir, key), toSpreadCsv(rows));
}
