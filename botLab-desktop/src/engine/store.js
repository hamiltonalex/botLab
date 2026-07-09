// store.js — disk persistence for the forward paper test. CRITICAL: paper positions + full
// accrual ledgers survive app restarts so a forward test resumes. Trailing history is cached as
// CSVs (same layout as spread_cache) so restarts don't refetch the whole window.
//
// All writes are atomic (write tmp -> rename) to avoid corruption on crash/quit. baseDir is
// app.getPath('userData') in production; a temp dir in tests.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
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
// directory — its cache backend purges foreign files there, so the CSV frames silently vanished on
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
// Whether a settings.json already exists — lets the post-update changelog logic tell a fresh install
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
// positions.json/settings.json — those are never read or written here (zero migration risk to the
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
export function loadBotSettings(baseDir, id) {
  ensureDir(baseDir);
  return readJson(botSettingsPath(baseDir, id), {});
}
export function saveBotSettings(baseDir, id, s) {
  ensureDir(baseDir);
  atomicWrite(botSettingsPath(baseDir, id), JSON.stringify(s, null, 2));
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
