// fa-eval.test.js - СВОДКА ПОСЛЕДНЕЙ ОЦЕНКИ: КОГДА СНИМАЕТСЯ, КОГДА ГАСНЕТ, ЧТО ПЕРЕЖИВАЕТ
// ПЕРЕЗАПУСК.
//
// ЧТО ЗДЕСЬ СТЕРЕЖЁТСЯ И ПОЧЕМУ ЭТО ВАЖНЕЕ, ЧЕМ ВЫГЛЯДИТ. Нарушение любого из трёх правил не ломает
// приложение: экран продолжает работать и продолжает ОБЪЯСНЯТЬ. Он просто объясняет неверно, а
// карточка «Последняя оценка» сама обещает обратное - её подпись говорит, что расхождение с журналом
// решений означает дефект. Дефект и означало:
//
//   1. СВОДКА НЕ ПЕРЕЖИВАЛА ПЕРЕЗАПУСК. Она жила только в памяти главного процесса, а отметка
//      последнего решения персистилась вместе с состоянием движка. После рестарта каданс уже
//      отсчитан, следующая оценка через сутки, и всё это время карточка говорила «оценки ещё не
//      было» рядом с фактическим временем этой самой оценки.
//   2. СВОДКА НЕ ГАСЛА. После остановки штамп продолжал обещать «следующая не раньше T», а зона
//      «Рынок бота» называла кандидата: оценку, которой не будет.
//   3. ПЕРЕВЗВОД С ДРУГИМ КАПИТАЛОМ ОСТАВЛЯЛ СТАРЫЙ РАНГ. Ранг считает `bestAlternative(capitalUsd)`,
//      то есть он посчитан ПРОТИВ ПОТОЛКА, и при другом потолке это оценка другого автомата.
//
// ХОД ЧЕРЕЗ ДИСК НАСТОЯЩИЙ, а не подменённый: запись и подъём идут теми же `saveBotState` /
// `loadBotStateQuarantine`, которыми ходит главный процесс, во временный каталог. Подменённое
// хранилище проверяло бы не тот путь, который исполняется.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBotStateQuarantine, saveBotState } from "../src/engine/store.js";
import { faEvalClears, faEvalFromDisk, faEvalOfTick, faEvalToDisk } from "../src/main/fa-eval.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOT = "funding-arb-auto";
const EVAL_ID = `${BOT}-eval`;
const T = Date.UTC(2026, 7, 31, 6, 0, 0);

const rows = () => ([
  { token: "ETH", strategy: "two", config: "A", refusal: null, refusalFrom: null, funded: true, sizeUsd: 1995.26, netUsd: 37.5, rank: 1, coverage: 0.97 },
  { token: "BTC", strategy: "two", config: "B", refusal: "below_fund_ratio", refusalFrom: "curve", funded: false, sizeUsd: null, netUsd: null, rank: null, coverage: 0.99 },
]);
const decided = (over = {}) => ({ decided: true, evalMarkets: rows(), ...over });

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "fa-eval-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. КОГДА СНИМАЕТСЯ
// ─────────────────────────────────────────────────────────────────────────────

test("сводка снимается ТОЛЬКО на цикле решения, и тик без решения её не стирает", () => {
  const ev = faEvalOfTick(decided(), { nowMs: T, cadenceH: 24, capitalUsd: 2500 });
  assert.equal(ev.at, T);
  assert.equal(ev.cadenceH, 24);
  assert.equal(ev.capitalUsd, 2500, "потолок капитала едет со строками: ранг посчитан против него");
  assert.equal(ev.markets.length, 2);
  // Тик без решения (каданс не подошёл) это «не трогать», а НЕ «стереть»: при опросе раз в пять
  // минут и кадансе в сутки таких тиков 287 из 288, и пустота поверх сводки гасила бы её навсегда.
  assert.equal(faEvalOfTick({ decided: false, evalMarkets: null }, { nowMs: T }), null);
  assert.equal(faEvalOfTick({ decided: true, evalMarkets: null }, { nowMs: T }), null);
  assert.equal(faEvalOfTick(null, { nowMs: T }), null);
  // Без часов сводку не снять: время снятия это половина её смысла.
  assert.equal(faEvalOfTick(decided(), { nowMs: null }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ПЕРЕЗАПУСК
// ─────────────────────────────────────────────────────────────────────────────

test("сводка переживает перезапуск наравне с отметкой последнего решения", () => withDir((dir) => {
  const ev = faEvalOfTick(decided(), { nowMs: T, cadenceH: 24, capitalUsd: 2500 });
  saveBotState(dir, EVAL_ID, faEvalToDisk(BOT, ev));
  // «Перезапуск»: новый подъём с того же диска, без единого объекта из прошлой сессии.
  const back = faEvalFromDisk(loadBotStateQuarantine(dir, EVAL_ID).state);
  assert.deepEqual(back, ev, "поднятая сводка обязана быть той же, иначе карточка соврёт про свои строки");
  assert.equal(back.markets[0].rank, 1, "ранг переживает рестарт: без него зона Ⅰ теряет рынок бота");
}));

test("неполная или битая запись НЕ поднимается: половина сводки хуже её отсутствия", () => withDir((dir) => {
  const at = T;
  const bad = [
    null,
    {},
    { at: null, markets: rows() },
    { at, markets: [] },              // строк нет: пустая вселенная читалась бы как «рынков нет»
    { at, markets: "не массив" },
    { at, markets: [{ nope: 1 }] },   // строка без токена: колонка рынка была бы пустой
  ];
  for (const raw of bad) assert.equal(faEvalFromDisk(raw), null, `поднялась запись, которой нельзя: ${JSON.stringify(raw)}`);
  // И то же через настоящий диск, включая нечитаемый JSON.
  writeFileSync(join(dir, `${EVAL_ID}.json`), "{это не json", "utf8");
  const res = loadBotStateQuarantine(dir, EVAL_ID);
  assert.equal(res.corrupt, true, "битый JSON обязан уйти в карантин, а не перезаписаться молча");
  assert.equal(faEvalFromDisk(res.state), null);
}));

test("сводка лежит в СВОЁМ файле, а не в состоянии движка", () => withDir((dir) => {
  saveBotState(dir, BOT, { schemaVersion: 1, botId: BOT, on: true, lastDecisionAt: T });
  saveBotState(dir, EVAL_ID, faEvalToDisk(BOT, faEvalOfTick(decided(), { nowMs: T, cadenceH: 24, capitalUsd: 2500 })));
  // Битый файл состояния движка поднимает автомат ВЫКЛЮЧЕННЫМ. Если бы сводка лежала там же,
  // оборванная на записи сводка для экрана уносила бы с собой тумблер, а это несоразмерный размен.
  const engine = JSON.parse(readFileSync(join(dir, `${BOT}.json`), "utf8"));
  assert.equal(engine.lastEval, undefined, "состояния движка сводка не касается ни полем");
  assert.ok(faEvalFromDisk(loadBotStateQuarantine(dir, EVAL_ID).state), "а в своём файле она есть");
}));

// ─────────────────────────────────────────────────────────────────────────────
// 3. ГАШЕНИЕ
// ─────────────────────────────────────────────────────────────────────────────

test("взвод гасит сводку, полная остановка гасит, запрошенная остановка при сделке - нет", () => {
  assert.equal(faEvalClears({ arming: true, on: true }), true,
    "взвод: параметры заморожены заново, и ранг старой сводки посчитан против прежнего потолка");
  assert.equal(faEvalClears({ arming: false, on: false }), true,
    "автомат выключен: обещать «следующая не раньше T» и называть кандидата больше нечем");
  assert.equal(faEvalClears({ arming: false, on: true }), false,
    "остановка запрошена, но сделка ведётся: автомат решает каждый каданс, и сводка ЖИВАЯ");
});

test("гашение пишется явной пустой записью, и она не поднимается обратно", () => withDir((dir) => {
  saveBotState(dir, EVAL_ID, faEvalToDisk(BOT, faEvalOfTick(decided(), { nowMs: T, cadenceH: 24, capitalUsd: 2500 })));
  saveBotState(dir, EVAL_ID, faEvalToDisk(BOT, null));
  assert.equal(faEvalFromDisk(loadBotStateQuarantine(dir, EVAL_ID).state), null,
    "погашенная сводка не имеет права воскреснуть на следующем запуске");
}));

// ─────────────────────────────────────────────────────────────────────────────
// 4. ПРОВОДКА В ГЛАВНОМ ПРОЦЕССЕ
//
// Политика выше бесполезна, если её никто не зовёт: ровно так дефект и выглядел - правило
// «сводка переживает перезапуск» существовало в голове, а строки, которая пишет её на диск, не было.
// `main.js` тянет Electron и под юнит-тест не идёт, поэтому проводка проверяется по исходнику - тем
// же приёмом, каким `fa-ui.test.js` разбирает таблицы отрисовщика.
// ─────────────────────────────────────────────────────────────────────────────

test("главный процесс зовёт политику сводки во всех трёх точках", () => {
  const main = readFileSync(join(HERE, "..", "src", "main", "main.js"), "utf8");
  assert.match(main, /faEvalOfTick\(tick,/, "на тике сводка снимается политикой, а не собирается на месте");
  assert.match(main, /if \(ev\) \{\s*\n\s*state\.auto\.lastEval = ev;\s*\n[\s\S]{0,400}?persistFaEval\(\);/,
    "снятая сводка обязана уходить НА ДИСК тем же движением, что и в память");
  assert.match(main, /faEvalClears\(\{ arming: req\.on === true, on: !!state\.auto\.engine\.on \}\)/,
    "взвод и остановка обязаны спрашивать политику, а не решать на месте");
  assert.match(main, /state\.auto\.lastEval = faEvalFromDisk\(/, "на буте сводка поднимается с диска");
  assert.match(main, /loadFaEval\(\);/, "подъём обязан быть позван из подъёма автомата");
});
