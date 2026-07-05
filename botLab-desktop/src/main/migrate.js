// migrate.js — one-time userData migration when the app's productName changes.
//
// app.getPath("userData") resolves to <appData>/<productName>. Renaming productName
// ("Funding-Arb Paper Simulator" -> "BotLab") therefore points Electron at a NEW, empty directory,
// while every existing user's forward-test ledger + settings still live in the OLD one. Without a
// migration the rename would silently start each user from scratch and lose open paper positions.
//
// Design:
//   - COPY, never move: an interrupted copy leaves the old directory fully intact and the next boot
//     retries. The old directory is deliberately left in place as a rollback safety net (the user
//     deletes it when they remove the old app).
//   - Idempotent: a marker file + a "new dir already has data" guard make repeat boots no-ops, and
//     guarantee we never clobber a BotLab install that has already been used.
//   - ALLOWLIST only our own files. userData is shared with Chromium; copying the whole directory
//     would drag in Cache/, GPUCache/, Local Storage/, cookies, etc. — version-specific state that
//     conflicts with the fresh profile (see the cache/ collision scar in store.js).

import { existsSync, mkdirSync, cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LEGACY_PRODUCT_NAME = "Funding-Arb Paper Simulator";
export const MIGRATION_MARKER = ".migrated-from-fundingarb";
// Exactly the files/dirs store.js persists — nothing Chromium owns.
export const MIGRATE_ENTRIES = ["settings.json", "positions.json", "frame-cache"];
// A meaningful legacy profile has at least one of these (a bare frame-cache/ alone is refetchable).
const SIGNAL_FILES = ["settings.json", "positions.json"];

// Pure and injectable so it can be unit-tested against real temp dirs (or mocked fs).
export function migrateLegacyUserData({
  newDir,
  appDataDir,
  legacyName = LEGACY_PRODUCT_NAME,
  entries = MIGRATE_ENTRIES,
  log = () => {},
  fs = { existsSync, mkdirSync, cpSync, writeFileSync },
} = {}) {
  const oldDir = join(appDataDir, legacyName);
  const marker = join(newDir, MIGRATION_MARKER);
  const has = (dir, name) => fs.existsSync(join(dir, name));

  if (oldDir === newDir) return { migrated: false, reason: "same-dir" };
  if (fs.existsSync(marker)) return { migrated: false, reason: "already-migrated" };
  // Never overwrite a BotLab profile that has already been written to.
  if (SIGNAL_FILES.some((f) => has(newDir, f))) return { migrated: false, reason: "new-dir-in-use" };
  // Nothing worth migrating.
  if (!SIGNAL_FILES.some((f) => has(oldDir, f))) return { migrated: false, reason: "no-legacy-data" };

  try {
    fs.mkdirSync(newDir, { recursive: true });
    const copied = [];
    for (const entry of entries) {
      if (has(oldDir, entry)) {
        fs.cpSync(join(oldDir, entry), join(newDir, entry), { recursive: true });
        copied.push(entry);
      }
    }
    fs.writeFileSync(marker, `migrated from ${oldDir}\ncopied: ${copied.join(", ")}\n`);
    log(`[main] userData migrated: "${oldDir}" -> "${newDir}" (${copied.join(", ")})`);
    return { migrated: true, oldDir, newDir, copied };
  } catch (err) {
    // Migration must never block boot: on failure the app starts with a fresh profile and the legacy
    // directory is left untouched for a later retry / manual recovery.
    log(`[main] userData migration failed (starting fresh, legacy dir untouched): ${err.message}`);
    return { migrated: false, reason: "error", error: err };
  }
}
