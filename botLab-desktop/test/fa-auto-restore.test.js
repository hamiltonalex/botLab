// fa-auto-restore.test.js - ПЕРСИСТ АВТОМАТА БОТА 1: что именно переживает падение приложения.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. `fa-auto.test.js` проверяет решение, а здесь проверяется другое свойство и
// другим способом: состояние гоняется через НАСТОЯЩИЙ диск теми же функциями, что зовёт главный
// процесс. Между «редьюсер вернул верное состояние» и «после рестарта бот работает» помещается
// целый класс дефектов: потерянный тумблер, разъехавшиеся файлы, битый JSON, стёртый журнал баз.
//
// ЗЕРКАЛО main.js. Функции `loadOrInit` / `persist` ниже повторяют `loadOrInitFaAuto()` и
// `persistFaAuto()` главного процесса; контракт персиста юнит-тестится без Electron, прецедент
// `btcopt-store.test.js` и `otmscan-store.test.js`.
//
// ИЗОЛЯЦИЯ ФАЗЫ 0 СТЕРЕЖЁТСЯ И ЗДЕСЬ: автомат не имеет права создать ни одного файла бота 2 и ни
// одного файла ручного бумажного теста. У бота 2 идёт живой прогон.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBotStateQuarantine, loadFaBases, saveBotState, saveFaBases } from "../src/engine/store.js";
import {
  AUTO_SCHEMA_VERSION, FA_AUTO_BOT_ID, armAuto, autoTick, createAutoState, ensureAutoState,
} from "../src/engine/fa/auto.js";
import { applyObservedBases, emptyBaseJournal, observeBases } from "../src/engine/fa/bases.js";
import { parseSpreadCsv, toSpreadCsv } from "../src/engine/format.js";
import { mergeFrames, HOUR } from "../src/engine/backfill.js";

const ID = FA_AUTO_BOT_ID;
const T = 1.7e12;
const tmp = () => mkdtempSync(join(tmpdir(), "fa-auto-"));

// Зеркало loadOrInitFaAuto(): карантин битого JSON, аддитивный подъём формы, forward-миграция.
function loadOrInit(dir) {
  const res = loadBotStateQuarantine(dir, ID);
  let st = res.state;
  if (!st || typeof st !== "object") {
    st = createAutoState({ nowMs: T });
    saveBotState(dir, ID, st);
  } else {
    ensureAutoState(st);
    if ((st.schemaVersion || 0) < AUTO_SCHEMA_VERSION) {
      st.schemaVersion = AUTO_SCHEMA_VERSION;
      saveBotState(dir, ID, st);
    }
  }
  return { state: st, corrupt: res.corrupt };
}
const persist = (dir, st) => saveBotState(dir, ID, st);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Тумблер и слот переживают рестарт
// ─────────────────────────────────────────────────────────────────────────────

test("ВЗВЕДЁННЫЙ АВТОМАТ ОСТАЁТСЯ ВЗВЕДЁННЫМ после рестарта, вместе со слотом и параметрами", () => {
  const dir = tmp();
  try {
    const first = loadOrInit(dir).state;
    assert.equal(first.on, false, "чистая установка это ВЫКЛЮЧЕННЫЙ автомат");
    armAuto(first, { nowMs: T, params: { capitalUsd: 2500 } });
    first.positionId = "p42";
    first.lastDecisionAt = T;
    persist(dir, first);

    // Приложение упало и поднялось.
    const back = loadOrInit(dir);
    assert.equal(back.corrupt, false);
    assert.equal(back.state.on, true, "тумблер, не переживший рестарт, это выключенный без спроса бот");
    assert.equal(back.state.positionId, "p42", "слот обязан пережить: иначе своя сделка станет чужой");
    assert.equal(back.state.armedAt, T);
    assert.equal(back.state.lastDecisionAt, T, "иначе каданс обнулялся бы каждым рестартом");
    assert.equal(back.state.params.capitalUsd, 2500, "параметры замораживаются ПРИ ВЗВОДЕ и переживают его");
    // Файл ровно один и лежит там, где сказано.
    assert.ok(existsSync(join(dir, `${ID}.json`)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ПОТЕРЯННЫЙ СЛОТ виден как orphan_position, а не как пустой слот", () => {
  const dir = tmp();
  try {
    const st = armAuto(loadOrInit(dir).state, { nowMs: T });
    st.positionId = "p42";
    st.lastTickAt = T - 300000;
    persist(dir, st);
    const back = loadOrInit(dir).state;
    // Леджер сделки не содержит (её удалили руками): автомат обязан НАЗВАТЬ расхождение, а не
    // тихо открыть вторую. Слот один, и молчаливое «слот свободен» это удвоение позиции.
    const t = autoTick({ now: T, bootAt: T - 3600000, state: back, markets: [], position: null, nominalSec: 300 });
    assert.equal(t.why, "orphan_position");
    assert.equal(t.kind, "none");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("БИТЫЙ JSON КАРАНТИНИТСЯ, и автомат поднимается ВЫКЛЮЧЕННЫМ, а не «как было»", () => {
  const dir = tmp();
  try {
    const st = armAuto(loadOrInit(dir).state, { nowMs: T });
    st.positionId = "p42";
    persist(dir, st);
    writeFileSync(join(dir, `${ID}.json`), "{это не JSON");
    const back = loadOrInit(dir);
    assert.equal(back.corrupt, true);
    assert.equal(back.state.on, false, "молча подменённое состояние это молча включённый или выключенный бот");
    // Испорченный файл СОХРАНЁН рядом: данные не уничтожаются одной плохой записью.
    assert.ok(readdirSync(dir).some((f) => f.startsWith(`${ID}.json.corrupt-`)));
    // И на первом же тике битое состояние старше любого вывода из него.
    const t = autoTick({ now: T, bootAt: T - 3600000, state: back.state, corrupt: back.corrupt, markets: [], nominalSec: 300 });
    assert.equal(t.why, "state_corrupt");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("НЕПРЕРЫВНОСТЬ КОПИТСЯ НА ДИСКЕ: перерыв, объяснённый один раз, объясним и через неделю", () => {
  const dir = tmp();
  try {
    const st = armAuto(loadOrInit(dir).state, { nowMs: T - 7200000 });
    st.lastTickAt = T - 3600000; // час без опроса
    const t = autoTick({ now: T, bootAt: T - 7200000, state: st, markets: [], nominalSec: 300 });
    persist(dir, t.state);
    const back = loadOrInit(dir).state;
    assert.equal(back.uptime.gaps.length, 1);
    assert.equal(back.uptime.gaps[0].ms, 3600000);
    assert.equal(back.uptime.gaps[0].lost, 11, "час при опросе раз в пять минут это одиннадцать потерянных слотов");
    assert.ok(back.uptime.ticks >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Журнал баз переживает рестарт и наполняет кадр
// ─────────────────────────────────────────────────────────────────────────────

test("ЖУРНАЛ НАБЛЮДЁННЫХ БАЗ ПЕРЕЖИВАЕТ РЕСТАРТ, иначе 720 часов не наберутся никогда", () => {
  const dir = tmp();
  try {
    const key = "ETH";
    let j = loadFaBases(dir, key) || emptyBaseJournal();
    assert.deepEqual(j.obs, [], "наблюдений ещё не было, и это не ошибка");
    for (let i = 0; i < 3; i += 1) {
      j = observeBases(j, { tsHour: 486223 + i, fbaseLongUsd: 2e6 + i, fbaseShortUsd: 1e6 + i }).journal;
    }
    saveFaBases(dir, key, j);
    // Рестарт.
    const back = loadFaBases(dir, key);
    assert.equal(back.obs.length, 3);
    assert.deepEqual(back.obs[0], [486223, 2e6, 1e6]);
    // Файл лежит СВОИМ каталогом и не задевает ни кадров, ни состояний.
    assert.ok(existsSync(join(dir, "fa-bases", `${key}.json`)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ПОЛНЫЙ КРУГ БЛОКЕРА: наблюдение переживает и рестарт, и исторический долив, и запись кадра", () => {
  const dir = tmp();
  try {
    // Час берётся ТОЙ ЖЕ дорогой, что в живом тракте: `nowHourTs()` отдаёт эпоху-СЕКУНДЫ,
    // выровненные по часу, и `tsHour` строки кадра это ровно она же.
    const tsHour = Math.floor(Date.UTC(2026, 0, 1, 12) / 1000 / HOUR) * HOUR;
    const ts = new Date(tsHour * 1000).toISOString();
    // 1. Живой опрос наблюдал базу часа, строки этого часа в кадре ещё НЕТ.
    const j = observeBases(emptyBaseJournal(), { tsHour, fbaseLongUsd: 2e6, fbaseShortUsd: 1e6 }).journal;
    saveFaBases(dir, "ETH", j);
    // 2. Приложение упало и поднялось; история наконец отдала строку этого часа БЕЗ баз.
    const fetched = [{ ts, tsHour, f_long: -1e-8, f_short: 2e-8, b_long: 0, b_short: 0, hl_rate: 0, hl_premium: 0 }];
    const withBases = applyObservedBases(fetched, loadFaBases(dir, "ETH")).rows;
    assert.equal(withBases[0].fbase_short, 1e6, "наблюдение дождалось своей строки");
    // 3. Кадр записан на диск и прочитан обратно: базы переживают круг CSV.
    const back = parseSpreadCsv(toSpreadCsv(withBases));
    assert.equal(back[0].tsHour, tsHour, "круг через CSV обязан сохранить час, иначе долив потеряет строку молча");
    assert.equal(back[0].fbase_short, 1e6);
    assert.equal(back[0].fbase_long, 2e6);
    // 4. Следующий исторический долив ставок базу НЕ стирает.
    const merged = mergeFrames(back, [{ ts, tsHour, f_long: -9e-8, f_short: 9e-8 }], 24, tsHour + HOUR);
    assert.equal(merged[0].f_short, 9e-8, "ставка обязана браться свежая");
    assert.equal(merged[0].fbase_short, 1e6, "а база наблюдённая");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Изоляция: автомат не создаёт чужих файлов
// ─────────────────────────────────────────────────────────────────────────────

test("автомат НЕ создаёт файлов бота 2 и не трогает файлы ручного бумажного теста", () => {
  const dir = tmp();
  try {
    const st = armAuto(loadOrInit(dir).state, { nowMs: T });
    persist(dir, st);
    saveFaBases(dir, "ETH", observeBases(emptyBaseJournal(), { tsHour: 1, fbaseLongUsd: 1, fbaseShortUsd: 1 }).journal);
    const files = readdirSync(dir);
    for (const forbidden of ["btc-options.json", "btc-options-settings.json", "btc-options-history.json",
      "otm-scanner.json", "positions.json", "settings.json"]) {
      assert.ok(!files.includes(forbidden), `автомат создал чужой файл ${forbidden}`);
    }
    assert.deepEqual(files.sort(), ["fa-bases", `${ID}.json`], "своих файлов ровно два места и ни одного лишнего");
    const raw = JSON.parse(readFileSync(join(dir, `${ID}.json`), "utf8"));
    assert.equal(raw.botId, ID, "чужой читатель обязан по одному полю понять, чей это файл");
    assert.equal(raw.schemaVersion, AUTO_SCHEMA_VERSION);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
