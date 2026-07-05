import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateLegacyUserData, LEGACY_PRODUCT_NAME, MIGRATION_MARKER } from "../src/main/migrate.js";

// Build a fake appData root with a legacy profile, return the paths the migration needs.
function scaffold({ legacy = {}, current = null } = {}) {
  const appDataDir = mkdtempSync(join(tmpdir(), "botlab-appdata-"));
  const oldDir = join(appDataDir, LEGACY_PRODUCT_NAME);
  const newDir = join(appDataDir, "BotLab");
  if (legacy) {
    mkdirSync(oldDir, { recursive: true });
    if (legacy.settings) writeFileSync(join(oldDir, "settings.json"), legacy.settings);
    if (legacy.positions) writeFileSync(join(oldDir, "positions.json"), legacy.positions);
    if (legacy.frames) {
      mkdirSync(join(oldDir, "frame-cache"), { recursive: true });
      writeFileSync(join(oldDir, "frame-cache", "ETH.csv"), legacy.frames);
    }
    // a Chromium cache dir that must NOT be copied
    mkdirSync(join(oldDir, "Cache"), { recursive: true });
    writeFileSync(join(oldDir, "Cache", "data_0"), "chromium-junk");
  }
  if (current) {
    mkdirSync(newDir, { recursive: true });
    for (const [k, v] of Object.entries(current)) writeFileSync(join(newDir, k), v);
  }
  return { appDataDir, oldDir, newDir, cleanup: () => rmSync(appDataDir, { recursive: true, force: true }) };
}

test("migrates settings, positions and frame-cache; leaves Chromium caches and the legacy dir intact", () => {
  const s = scaffold({ legacy: { settings: '{"win":7}', positions: "[{}]", frames: "ts,val\n1,2\n" } });
  try {
    const r = migrateLegacyUserData({ newDir: s.newDir, appDataDir: s.appDataDir });
    assert.equal(r.migrated, true);
    assert.deepEqual(r.copied.sort(), ["frame-cache", "positions.json", "settings.json"]);
    // data landed
    assert.equal(readFileSync(join(s.newDir, "settings.json"), "utf8"), '{"win":7}');
    assert.equal(readFileSync(join(s.newDir, "positions.json"), "utf8"), "[{}]");
    assert.equal(readFileSync(join(s.newDir, "frame-cache", "ETH.csv"), "utf8"), "ts,val\n1,2\n");
    // Chromium cache NOT copied
    assert.equal(existsSync(join(s.newDir, "Cache")), false);
    // marker written, legacy dir untouched (rollback safety)
    assert.equal(existsSync(join(s.newDir, MIGRATION_MARKER)), true);
    assert.equal(existsSync(join(s.oldDir, "settings.json")), true);
  } finally {
    s.cleanup();
  }
});

test("is idempotent: a second run is a no-op and does not re-copy", () => {
  const s = scaffold({ legacy: { settings: '{"win":1}', positions: "[]" } });
  try {
    assert.equal(migrateLegacyUserData({ newDir: s.newDir, appDataDir: s.appDataDir }).migrated, true);
    // user edits the new profile; a second boot must not clobber it back to the legacy copy
    writeFileSync(join(s.newDir, "settings.json"), '{"win":30}');
    const r2 = migrateLegacyUserData({ newDir: s.newDir, appDataDir: s.appDataDir });
    assert.equal(r2.migrated, false);
    assert.equal(r2.reason, "already-migrated");
    assert.equal(readFileSync(join(s.newDir, "settings.json"), "utf8"), '{"win":30}');
  } finally {
    s.cleanup();
  }
});

test("never clobbers a BotLab profile that already has data (no marker yet)", () => {
  const s = scaffold({ legacy: { settings: "OLD" }, current: { "positions.json": "[{ }]" } });
  try {
    const r = migrateLegacyUserData({ newDir: s.newDir, appDataDir: s.appDataDir });
    assert.equal(r.migrated, false);
    assert.equal(r.reason, "new-dir-in-use");
    assert.equal(existsSync(join(s.newDir, "settings.json")), false); // not pulled from legacy
  } finally {
    s.cleanup();
  }
});

test("no legacy data -> no-op, no marker (fresh install boots clean)", () => {
  const s = scaffold({ legacy: null });
  try {
    const r = migrateLegacyUserData({ newDir: s.newDir, appDataDir: s.appDataDir });
    assert.equal(r.migrated, false);
    assert.equal(r.reason, "no-legacy-data");
    assert.equal(existsSync(join(s.newDir, MIGRATION_MARKER)), false);
  } finally {
    s.cleanup();
  }
});

test("bare legacy frame-cache alone is not treated as migratable (refetchable)", () => {
  const s = scaffold({ legacy: { frames: "ts,val\n1,2\n" } });
  try {
    const r = migrateLegacyUserData({ newDir: s.newDir, appDataDir: s.appDataDir });
    assert.equal(r.migrated, false);
    assert.equal(r.reason, "no-legacy-data");
  } finally {
    s.cleanup();
  }
});

test("migration failure never throws; returns error result and leaves legacy dir untouched", () => {
  const s = scaffold({ legacy: { settings: "X", positions: "[]" } });
  try {
    const boom = () => { throw new Error("disk full"); };
    const r = migrateLegacyUserData({
      newDir: s.newDir,
      appDataDir: s.appDataDir,
      fs: { existsSync, mkdirSync, writeFileSync, cpSync: boom },
    });
    assert.equal(r.migrated, false);
    assert.equal(r.reason, "error");
    assert.equal(existsSync(join(s.oldDir, "settings.json")), true);
  } finally {
    s.cleanup();
  }
});
