// btcopt-store.test.js — Phase 0 isolation contract for bot 2 «BTC-опционы».
// Proves the additive persistence never disturbs funding-arb's files and that the create-on-first-run
// init is idempotent (writes exactly once). The pure engine skeleton must round-trip through JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBotState, saveBotState, loadBotSettings, saveBotSettings } from "../src/engine/store.js";
import * as engine from "../src/engine/btcopt/engine.js";

const ID = "btc-options";
const tmp = () => mkdtempSync(join(tmpdir(), "btcopt-store-"));

// Mirrors main.js loadOrInitBtcOptions() so the init contract is unit-tested without pulling in
// electron: create the state file exactly once, then be a no-op on subsequent boots.
function loadOrInit(baseDir, nowMs) {
  const settings = { ...engine.defaultSettings(), ...loadBotSettings(baseDir, ID) };
  let st = loadBotState(baseDir, ID);
  let wrote = false;
  if (!st) {
    st = engine.create({ settings, nowMs });
    saveBotState(baseDir, ID, st);
    wrote = true;
  } else if ((st.schemaVersion || 0) < engine.SCHEMA_VERSION) {
    st.schemaVersion = engine.SCHEMA_VERSION;
    saveBotState(baseDir, ID, st);
    wrote = true;
  }
  return { st, settings, wrote };
}

test("engine.create() returns a persist-round-trippable skeleton with schemaVersion + botId", () => {
  const st = engine.create({ nowMs: 1000 });
  assert.equal(st.schemaVersion, engine.SCHEMA_VERSION);
  assert.equal(st.botId, "btc-options");
  assert.equal(st.structure, null);
  assert.ok(st.settings && typeof st.settings === "object");
  // no undefined / functions / Map — survives JSON persistence exactly
  assert.deepEqual(st, JSON.parse(JSON.stringify(st)));
});

test("loadOrInit writes the state file exactly once; second boot is a no-op", () => {
  const dir = tmp();
  try {
    assert.equal(loadBotState(dir, ID), null); // first run: nothing on disk
    const first = loadOrInit(dir, 1);
    assert.equal(first.wrote, true);
    assert.ok(existsSync(join(dir, "btc-options.json")));

    const second = loadOrInit(dir, 2);
    assert.equal(second.wrote, false); // idempotent — file already exists
    assert.equal(second.st.schemaVersion, engine.SCHEMA_VERSION);
    assert.equal(second.st.botId, "btc-options");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bot-2 persistence NEVER creates funding-arb's positions.json / settings.json", () => {
  const dir = tmp();
  try {
    loadOrInit(dir, 1);
    saveBotSettings(dir, ID, { lambda: 1.5 });
    saveBotState(dir, ID, engine.create({ nowMs: 1 }));
    // the working bot's files are untouched (zero migration risk)
    assert.equal(existsSync(join(dir, "positions.json")), false);
    assert.equal(existsSync(join(dir, "settings.json")), false);
    // the isolated files DO exist
    assert.equal(existsSync(join(dir, "btc-options.json")), true);
    assert.equal(existsSync(join(dir, "btc-options-settings.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bot settings round-trip; absent settings default to {}; state round-trips", () => {
  const dir = tmp();
  try {
    assert.deepEqual(loadBotSettings(dir, ID), {});
    saveBotSettings(dir, ID, { lambda: 1.75, testnet: true });
    assert.deepEqual(loadBotSettings(dir, ID), { lambda: 1.75, testnet: true });
    const st = engine.create({ nowMs: 42 });
    saveBotState(dir, ID, st);
    assert.deepEqual(loadBotState(dir, ID), st);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forward-migration guard bumps an older schemaVersion and persists", () => {
  const dir = tmp();
  try {
    // an on-disk v0 state (a hypothetical earlier build)
    saveBotState(dir, ID, { schemaVersion: 0, botId: ID, settings: {}, structure: null, perpState: {}, ledger: [], metrics: {} });
    const r = loadOrInit(dir, 1);
    assert.equal(r.wrote, true); // guard fired
    assert.equal(r.st.schemaVersion, engine.SCHEMA_VERSION);
    assert.equal(loadBotState(dir, ID).schemaVersion, engine.SCHEMA_VERSION); // persisted
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
