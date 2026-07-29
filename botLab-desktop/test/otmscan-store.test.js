// otmscan-store.test.js — S2 персист-контракт «OTM-сканера» (план §12-S2, закон Phase 0).
// Доказывает: (1) аддитивная персистентность сканера НИКОГДА не создаёт файлы funding-arb
// (positions.json/settings.json) И бота 2 (btc-options*.json); (2) init идемпотентен (файл
// пишется ровно один раз); (3) ACTIVE-сигнал (замороженный контракт §8.1) переживает рестарт —
// §7 случай 14; (4) телеметрия живёт ОТДЕЛЬНЫМ файлом: суточные вёдра персистятся, session
// умирает с сессией, state-файл телеметрию не несёт; (5) битый JSON карантинится в
// .corrupt-<ts>, а не перезаписывается молча — §7 случай 17.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBotSettings, saveBotSettings, saveBotState, loadBotStateQuarantine } from "../src/engine/store.js";
import { createScanState } from "../src/engine/otmscan/scan-engine.js";
import { defaultScanSettings, SCAN_SCHEMA_VERSION } from "../src/engine/otmscan/presets.js";
import { foldScanStats } from "../src/main/scn-stats.js";

const ID = "otm-scanner";
const tmp = () => mkdtempSync(join(tmpdir(), "otmscan-store-"));
const signalFixture = () =>
  JSON.parse(readFileSync(new URL("./fixtures/otmscan/signal-example.json", import.meta.url), "utf8"));

// Зеркало main.js persistScanState()/flushScanTelemetry()/loadOrInitOtmScanner() — контракт
// персиста юнит-тестится без electron (прецедент btcopt-store.test.js). Раздел: otm-scanner.json
// несёт редьюсер БЕЗ телеметрии; otm-scanner-telemetry.json — только суточные вёдра.
function persistState(dir, engineState) {
  const { telemetry, ...core } = engineState;
  saveBotState(dir, ID, { botId: ID, ...core });
}
function persistTelemetry(dir, engineState, stats) {
  saveBotState(dir, `${ID}-telemetry`, {
    schemaVersion: SCAN_SCHEMA_VERSION,
    botId: ID,
    days: engineState.telemetry?.days ?? {},
    stats: { days: stats?.days ?? {} }, // S3b: статистика обкатки — аддитивный ключ того же файла
  });
}
function loadOrInit(dir) {
  const settings = { ...defaultScanSettings(), ...loadBotSettings(dir, ID) };
  if (!settings.userPresets || typeof settings.userPresets !== "object") settings.userPresets = {};
  const stRes = loadBotStateQuarantine(dir, ID);
  const telRes = loadBotStateQuarantine(dir, `${ID}-telemetry`);
  const persisted = stRes.state && typeof stRes.state === "object" ? stRes.state : null;
  const engineState = {
    ...createScanState(),
    ...(persisted ?? {}),
    telemetry: {
      session: {}, // сессионные счётчики умирают с сессией по определению §5.6
      days: telRes.state?.days && typeof telRes.state.days === "object" ? telRes.state.days : {},
    },
  };
  if (!Array.isArray(engineState.journal)) engineState.journal = [];
  if ((engineState.schemaVersion || 0) < SCAN_SCHEMA_VERSION) engineState.schemaVersion = SCAN_SCHEMA_VERSION;
  // S3b (зеркало main.js): статистика обкатки — из того же telemetry-файла, аддитивный ключ stats.
  const stats = { days: telRes.state?.stats?.days && typeof telRes.state.stats.days === "object" ? telRes.state.stats.days : {} };
  let wrote = false;
  if (!persisted) {
    persistState(dir, engineState);
    wrote = true;
  }
  return { engineState, settings, stats, wrote, corrupt: stRes.corrupt };
}

test("первый запуск пишет otm-scanner.json ровно один раз; второй бут — no-op", () => {
  const dir = tmp();
  try {
    const first = loadOrInit(dir);
    assert.equal(first.wrote, true);
    assert.equal(first.engineState.phase, "idle");
    assert.ok(existsSync(join(dir, "otm-scanner.json")));

    const second = loadOrInit(dir);
    assert.equal(second.wrote, false); // идемпотентность: «маркер» = существование файла
    assert.equal(second.engineState.schemaVersion, SCAN_SCHEMA_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("изоляция Phase 0: файлы funding-arb И бота 2 НЕ создаются; свои три файла создаются", () => {
  const dir = tmp();
  try {
    const { engineState, settings } = loadOrInit(dir);
    saveBotSettings(dir, ID, { ...settings, event: { flagged: false, note: null, untilTs: null } });
    persistState(dir, engineState);
    persistTelemetry(dir, engineState);
    // рабочие боты не задеты (нулевой риск миграции)
    assert.equal(existsSync(join(dir, "positions.json")), false, "funding-arb positions нетронут");
    assert.equal(existsSync(join(dir, "settings.json")), false, "funding-arb settings нетронут");
    assert.equal(existsSync(join(dir, "btc-options.json")), false, "state бота 2 нетронут");
    assert.equal(existsSync(join(dir, "btc-options-settings.json")), false, "settings бота 2 нетронуты");
    // изолированные файлы сканера существуют
    assert.equal(existsSync(join(dir, "otm-scanner.json")), true);
    assert.equal(existsSync(join(dir, "otm-scanner-settings.json")), true);
    assert.equal(existsSync(join(dir, "otm-scanner-telemetry.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ACTIVE-сигнал (§8.1, фикстура) переживает рестарт целиком; телеметрия: days из своего файла, session пуст", () => {
  const dir = tmp();
  try {
    const day = { rv7d_gt_iv: { evals: 5, pass: 4, fail: 1, unknown: 0 } };
    const st = {
      ...createScanState(),
      phase: "active",
      signal: signalFixture(), // замороженный контракт §8.1 — вплоть до снапшота условий
      cooldowns: { "BTC_USDC-26JUL26-107500-C|call": 1784550000000 },
      hyst: { "rv7d_gt_iv|": "pass" },
      journal: [
        { ts: 1784548860000, event: "signal", id: "scn-x", instrument: "BTC_USDC-26JUL26-107500-C", direction: "call", score: "11/11", presetId: "dmitri-v1", eventNote: null, ttlSec: 900, reason: null },
      ],
      telemetry: { session: { rv7d_gt_iv: { evals: 9, pass: 9, fail: 0, unknown: 0 } }, days: { "2026-07-19": day } },
    };
    persistState(dir, st);
    persistTelemetry(dir, st);

    const back = loadOrInit(dir);
    assert.equal(back.wrote, false);
    assert.equal(back.engineState.phase, "active");
    assert.deepEqual(back.engineState.signal, st.signal, "контракт §8.1 восстановлен побайтно");
    assert.deepEqual(back.engineState.cooldowns, st.cooldowns);
    assert.deepEqual(back.engineState.hyst, st.hyst);
    assert.deepEqual(back.engineState.journal, st.journal);
    assert.deepEqual(back.engineState.telemetry.days, { "2026-07-19": day }, "суточные вёдра из telemetry-файла");
    assert.deepEqual(back.engineState.telemetry.session, {}, "session-счётчики НЕ переживают рестарт");
    // state-файл телеметрию не несёт вообще (раздел персиста — план §3.1)
    const raw = JSON.parse(readFileSync(join(dir, "otm-scanner.json"), "utf8"));
    assert.equal(raw.telemetry, undefined, "otm-scanner.json без телеметрии");
    assert.equal(raw.botId, ID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("битый JSON карантинится в .corrupt-<ts> и чисто ре-инитится (§7 случай 17)", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "otm-scanner.json"), "{ битый json без закрытия");
    const r = loadOrInit(dir);
    assert.equal(r.corrupt, true, "порча детектирована");
    assert.equal(r.engineState.phase, "idle", "чистый re-init");
    assert.equal(r.wrote, true, "новый чистый файл записан");
    assert.ok(
      readdirSync(dir).some((f) => f.startsWith("otm-scanner.json.corrupt-")),
      "битый файл сохранён в карантине, не уничтожен",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("настройки: event и userPresets ходят через otm-scanner-settings.json раунд-трипом", () => {
  const dir = tmp();
  try {
    assert.deepEqual(loadBotSettings(dir, ID), {});
    const custom = { presetId: "calibrated", scanRepriceSec: 60, userPresets: { calibrated: { id: "calibrated", premMaxPct: 0.5 } }, event: { flagged: true, note: "CPI", untilTs: 1784600000000 } };
    saveBotSettings(dir, ID, custom);
    assert.deepEqual(loadBotSettings(dir, ID), custom);
    const { settings } = loadOrInit(dir);
    assert.equal(settings.presetId, "calibrated");
    assert.equal(settings.scanRepriceSec, 60);
    assert.deepEqual(settings.userPresets, custom.userPresets);
    assert.equal(settings.dwellTicks, defaultScanSettings().dwellTicks, "недостающие ключи из дефолтов");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createScanState() JSON-чист: раунд-трип без потерь (нет undefined/функций/Map)", () => {
  const st = createScanState();
  assert.deepEqual(st, JSON.parse(JSON.stringify(st)));
});

test("S3b: статистика обкатки переживает рестарт через telemetry-файл; state-файл её не несёт", () => {
  const dir = tmp();
  try {
    const st = createScanState();
    const stats = foldScanStats(
      { days: {} },
      {
        preset: { id: "dmitri-v1" },
        score: { verdict: "none" },
        lifecycle: { phase: "idle", blackout: { active: false } },
        candidates: [],
        conditions: [{ key: "spread_cap", unit: "pctPrem", value: 7.5, state: "fail" }],
        economics: { roundTripCostPct: 15.2, minCapitalUsd: 120 },
      },
      { degraded: false, equityUsd: 100, repriceSec: 30 },
      Date.UTC(2026, 6, 20, 12),
    );
    persistState(dir, st);
    persistTelemetry(dir, st, stats);

    const back = loadOrInit(dir);
    assert.deepEqual(back.stats, JSON.parse(JSON.stringify(stats)), "распределения восстановлены побайтно");
    assert.equal(back.stats.days["2026-07-20"]["dmitri-v1"].rtc.n, 1);
    assert.equal(back.stats.days["2026-07-20"]["dmitri-v1"].capOverEq, 1);
    const rawState = JSON.parse(readFileSync(join(dir, "otm-scanner.json"), "utf8"));
    assert.equal(rawState.stats, undefined, "otm-scanner.json без статистики (раздел персиста)");
    // Файл ДО S3b (без ключа stats) читается без ошибок — форвард-совместимость.
    saveBotState(dir, `${ID}-telemetry`, { schemaVersion: SCAN_SCHEMA_VERSION, botId: ID, days: {} });
    assert.deepEqual(loadOrInit(dir).stats, { days: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
