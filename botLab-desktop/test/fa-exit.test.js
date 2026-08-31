// fa-exit.test.js - ПРАВИЛО ВЫХОДА БОТА 1 (fa/exit.js): три ветки максимума, отложенные решения и
// четыре свойства конструкции, которые обязаны держаться, а не подразумеваться.
//
// ОРАКУЛ, А НЕ ПЕРЕПРОВЕРКА КОДА СОБОЙ. На рынке с ПОСТОЯННЫМ потоком и нулевой ногой Hyperliquid
// валовой доход имеет замкнутый вид `gross(S) = P * S / (B + S)`, где `P` это весь поток окна в
// долларах, а круг равен `K2 * S + газ`. Отсюда ветки считаются на бумаге до вызова модуля, и
// проверки сравнивают его с НЕЗАВИСИМЫМ числом.
//
// ДАННЫЕ СТРОИТ КОНСТРУКТОР `hour()` ИЗ `fa-helpers.mjs`: тождество `|f_long|*B_long =
// |f_short|*B_short` выполняется по построению, и нарушить его в тесте нельзя.
//
// ПРЕДУСЛОВИЯ ЛОВУШЕК ПРОВЕРЯЮТСЯ ЯВНО. Тест на утопленный круг имеет смысл, только пока три числа
// стоят в нужном порядке; если данные уедут, он молча перестанет проверять ловушку и останется
// зелёным. Поэтому порядок утверждается отдельным `assert` ПЕРЕД проверкой решения.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpreadCsv } from "../src/engine/format.js";
import { scanTwoLeg } from "../src/engine/math.js";
import { DEFAULT_COSTS } from "../src/engine/costs.js";
import { FA_SIZING_DEFAULTS, bestSizeForMarket, netAtSize } from "../src/engine/fa/sizing.js";
import {
  FA_EXIT_ACTIONS, FA_EXIT_DEFAULTS, FA_EXIT_REASONS,
  decideExit, explainExit, holdGross, shouldDecideNow,
} from "../src/engine/fa/exit.js";
import { hour } from "./fa-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) < tol, `${label}: получено ${a}, ожидалось ${b} (+/-${tol})`);

const K2 = (DEFAULT_COSTS.gmxOpen + DEFAULT_COSTS.gmxClose + DEFAULT_COSTS.gmxImpact
  + DEFAULT_COSTS.hlTaker * DEFAULT_COSTS.hlSides) / 100;
const GAS = DEFAULT_COSTS.gmxGas;
const H = FA_SIZING_DEFAULTS.horizonH;

// Все причины, которые тесты действительно наблюдали. Реестр без достижимости это обещание, а не
// проверка, поэтому в конце файла множества сверяются.
const SEEN = new Set();
const decide = (args) => { const d = decideExit(args); SEEN.add(d.reason); return d; };

// Рынок с постоянным потоком. `P` это ВЕСЬ поток окна в долларах. `recv` называет ПОЛУЧАЮЩУЮ
// сторону: при "long" получает длинная, то есть наша короткая нога конфигурации A ПЛАТИТ.
const flat = ({ hours = H, P, bShort, bLong = 1e12, recv = "short" }) => {
  const pot = P / (3600 * hours);
  return Array.from({ length: hours }, (_, h) => hour(h, { pot, bShort, bLong, recv }));
};

// Конфигурация A держит КОРОТКУЮ ногу GMX, поэтому наша база это `fbase_short`. Нога Hyperliquid
// нулевая: она не разбавляется и линейна по размеру, то есть только сдвинула бы оракул.
const marketOf = (token, rows) => ({
  token, config: "A", strategy: "two", rows,
  live: { bOwnUsd: rows[rows.length - 1].fbase_short, bOtherUsd: rows[rows.length - 1].fbase_long },
  impact: null,
});
const posOf = (token, sizeUsd) => ({ token, config: "A", strategy: "two", sizeUsd });
const grossOracle = (P, B, S) => (P * S) / (B + S);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Брутто удержания: величина и главная ловушка конструкции
// ─────────────────────────────────────────────────────────────────────────────

test("брутто удержания совпадает с оракулом P*S/(B+S) и НЕ содержит круга", () => {
  const P = 2000;
  const B = 1e5;
  const S = 5000;
  const rows = flat({ P, bShort: B });
  const g = holdGross({ position: posOf("T", S), rows });
  near(g, grossOracle(P, B, S), 0.02, "брутто удержания");
  // Круг в этой величине быть НЕ ДОЛЖЕН: он платится в любой ветке и сокращается. Если бы здесь
  // стояло нетто, число было бы меньше ровно на круг.
  const withCost = netAtSize({ rows, config: "A", strategy: "two", sizeUsd: S, costs: DEFAULT_COSTS });
  near(withCost.gross - withCost.net, K2 * S + GAS, 1e-9, "круг при этом размере");
  assert.ok(g > withCost.net, "брутто обязано быть больше нетто ровно на круг");
});

test("кривые удара НЕ двигают брутто удержания побитово, хотя двигают круг", () => {
  // Из этого следует, что ветке удержания стакан не нужен. Ворота МОДУЛЯ он всё равно требует:
  // ветка перекладки считает нетто альтернативы, а там круг зависит от кривых.
  const rows = flat({ P: 2000, bShort: 1e5 });
  const a = netAtSize({ rows, config: "A", strategy: "two", sizeUsd: 2000, costs: DEFAULT_COSTS, impact: null });
  const b = netAtSize({
    rows, config: "A", strategy: "two", sizeUsd: 2000, costs: DEFAULT_COSTS,
    impact: { gmxNodes: [{ sizeUsd: 1000, bps: 5 }, { sizeUsd: 1e5, bps: 50 }], hlNodes: [{ sizeUsd: 1000, bps: 3 }, { sizeUsd: 1e5, bps: 30 }] },
  });
  assert.equal(a.gross, b.gross, "брутто обязано совпасть ПОБИТОВО");
  assert.ok(b.cost > a.cost, "а круг обязан вырасти, иначе кривые не применились вовсе");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Три ветки максимума, каждая своим тестом
// ─────────────────────────────────────────────────────────────────────────────

test("ДЕРЖАТЬ: та же сделка тем же размером перекладки не порождает никогда", () => {
  // Арифметика: альтернатива это тот же рынок, тот же размер, значит её нетто равно брутто минус
  // круг и строго меньше брутто. Это и есть отсутствие холостого оборота, доказанное, а не обещанное.
  const rows = flat({ P: 2000, bShort: 1e5 });
  const d = decide({ position: posOf("T", 5000), rows, markets: [marketOf("T", rows)], capitalAvailableUsd: 5000 });
  assert.equal(d.action, "hold");
  assert.equal(d.reason, "hold_best");
  assert.ok(d.switchNetUsd < d.holdGrossUsd, "нетто альтернативы обязано быть ниже брутто удержания");
  near(d.holdGrossUsd - d.switchNetUsd, K2 * 5000 + GAS, 0.02, "разрыв равен ровно кругу");
});

test("ПЕРЕЛОЖИТЬ: богатый рынок обходит удержание, и прибавка больше круга", () => {
  const cur = flat({ P: 60, bShort: 1e5 });
  const alt = flat({ P: 4000, bShort: 1e5 });
  const d = decide({
    position: posOf("CUR", 5000), rows: cur,
    markets: [marketOf("CUR", cur), marketOf("ALT", alt)], capitalAvailableUsd: 5000,
  });
  assert.equal(d.action, "switch");
  assert.equal(d.reason, "alt_beats_hold");
  assert.equal(d.best.token, "ALT");
  assert.ok(d.gainUsd > 0, "прибавка обязана быть положительной");
  // Прибавка это разность УЖЕ ПОСЛЕ круга: круг вычтен внутри нетто альтернативы.
  near(d.gainUsd, d.switchNetUsd - d.holdGrossUsd, 1e-9, "определение прибавки");
});

test("В КЭШ: платим мы, и годных альтернатив нет", () => {
  // ВЕТКА ДОСТИЖИМА ТОЛЬКО НА ВЫРОЖДЕННОЙ ВСЕЛЕННОЙ, и это ЗАМЕР, а не догадка: на рабочем наборе
  // (63 рынка, 8041 решение) она не сработала НИ РАЗУ, потому что перекладка её всегда накрывает.
  // Поэтому вселенная здесь пуста НАРОЧНО, и тест обязан это заявлять вслух.
  const rows = flat({ P: 2000, bShort: 1e5, recv: "long" }); // получает длинная сторона, наша короткая платит
  const g = holdGross({ position: posOf("T", 5000), rows });
  assert.ok(g < 0, "предусловие: брутто удержания обязано быть отрицательным");
  const d = decide({ position: posOf("T", 5000), rows, markets: [], capitalAvailableUsd: 5000 });
  assert.equal(d.action, "close");
  assert.equal(d.reason, "gross_negative");
  assert.equal(d.switchNetUsd, null, "альтернатив нет вовсе, а не «есть, но плохая»");
});

test("В КЭШ достижима и при НЕПУСТОЙ вселенной, когда все альтернативы отказали", () => {
  // Отличие от предыдущего теста существенное: там альтернатив не было, здесь они есть, но правило
  // ВХОДА их не финансирует. Правило выхода обязано уважать его отбор, а не заводить свой.
  const rows = flat({ P: 2000, bShort: 1e5, recv: "long" });
  const poor = flat({ P: 0.5, bShort: 1e5 }); // поток есть, но круг он не окупает
  const d = decide({ position: posOf("T", 5000), rows, markets: [marketOf("POOR", poor)], capitalAvailableUsd: 5000 });
  assert.ok(d.curves.length > 0 && d.curves.every((c) => c.refusal), "предусловие: все альтернативы обязаны отказать");
  assert.equal(d.action, "close");
  assert.equal(d.reason, "gross_negative");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Изменение размера НА МЕСТЕ: тот же рынок, другой размер
// ─────────────────────────────────────────────────────────────────────────────

test("тот же рынок с УЕХАВШИМ размером даёт ПЕРЕКЛАДКУ, а не удержание", () => {
  // В коде напрашивается оптимизация «лучшая альтернатива это текущий рынок, значит менять нечего».
  // Она выглядит очевидной, экономит вызов и молча убивает самый частый случай: на рабочем наборе
  // чистой сменой размера оказались 25 перекладок из 46 при кадансе 1 ч. Тест существует, чтобы
  // такую оптимизацию нельзя было внести незаметно ни сейчас, ни через полгода.
  const P = 2000;
  const B = 1e5;
  const rows = flat({ P, bShort: B });
  const small = 500;
  const d = decide({ position: posOf("T", small), rows, markets: [marketOf("T", rows)], capitalAvailableUsd: 5000 });
  assert.equal(d.action, "switch", "правило обязано увидеть, что тот же рынок стоит держать ДРУГИМ размером");
  assert.equal(d.best.token, "T", "рынок тот же самый");
  assert.ok(d.best.sizeUsd > small, "а размер другой");
  near(d.holdGrossUsd, grossOracle(P, B, small), 0.02, "брутто удержания при малом размере");
  assert.ok(d.switchNetUsd > d.holdGrossUsd, "нетто при новом размере обязано обойти брутто при старом");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Свойства конструкции
// ─────────────────────────────────────────────────────────────────────────────

test("ЛОВУШКА УТОПЛЕННОГО КРУГА: ветка удержания берёт БРУТТО, и подстановка нетто перевернула бы решение", () => {
  // Подобрано так, что три числа стоят в порядке `нетто_тек < нетто_альт < брутто_тек`. Верное
  // решение это ДЕРЖАТЬ; правило, сравнивающее альтернативу с НЕТТО текущей позиции, вычло бы круг,
  // который в ветке удержания не платится, и переложилось бы.
  // Подбор по оракулу: при потолке тикета $5000 обе стороны торгуются размером $5000, поэтому
  // `нетто = брутто - $16.50`. Нужно `брутто_альт` выше `брутто_тек`, но меньше чем на круг:
  // тогда нетто альтернативы обходит нетто текущей позиции и НЕ обходит её брутто.
  const cur = flat({ P: 2000, bShort: 1e5 });
  const alt = flat({ P: 2200, bShort: 1e5 });
  const pos = posOf("CUR", 5000);
  const holdUsd = holdGross({ position: pos, rows: cur });
  const curAsAlt = bestSizeForMarket({ ...marketOf("CUR", cur), costs: DEFAULT_COSTS });
  const altBest = bestSizeForMarket({ ...marketOf("ALT", alt), costs: DEFAULT_COSTS });
  // ПРЕДУСЛОВИЕ ЛОВУШКИ. Без него тест остался бы зелёным, перестав проверять ловушку.
  assert.ok(curAsAlt.netUsd < altBest.netUsd && altBest.netUsd < holdUsd,
    `предусловие не выполнено: нетто_тек ${curAsAlt.netUsd}, нетто_альт ${altBest.netUsd}, брутто_тек ${holdUsd}`);
  const d = decide({ position: pos, rows: cur, markets: [marketOf("CUR", cur), marketOf("ALT", alt)], capitalAvailableUsd: 5000 });
  assert.equal(d.action, "hold", "круг вычтен дважды: в ветке удержания он не платится");
});

test("НА НЕИЗМЕНИВШИХСЯ ДАННЫХ ПРАВИЛО НЕ КОЛЕБЛЕТСЯ: обратной перекладки не существует", () => {
  // Гистерезис не заводится параметром, он выпадает из критерия: уйти из A в B требует
  // `брутто_B - круг_B > брутто_A`, вернуться требует `брутто_A - круг_A > брутто_B`, и оба сразу
  // невозможны. Ширина полосы равна кругу, то есть ровно тому, во что колебание обходится.
  const a = flat({ P: 300, bShort: 1e5 });
  const b = flat({ P: 4000, bShort: 1e5 });
  const universe = [marketOf("A", a), marketOf("B", b)];
  const first = decide({ position: posOf("A", 5000), rows: a, markets: universe, capitalAvailableUsd: 5000 });
  assert.equal(first.action, "switch", "предусловие: из A уходим в B");
  assert.equal(first.best.token, "B");
  const back = decide({ position: posOf("B", first.best.sizeUsd), rows: b, markets: universe, capitalAvailableUsd: 5000 });
  assert.notEqual(back.action, "switch", "вернуться на тех же данных правило не имеет права");
  assert.equal(back.action, "hold");
});

test("РЕАЛИЗОВАННЫЙ PnL В РЕШЕНИЕ НЕ ВХОДИТ: он утоплен", () => {
  // Ратчет против будущей правки, которая захочет «дать позиции отбиться» или «зафиксировать
  // прибыль». Оба намерения означают решение по утопленной величине.
  const rows = flat({ P: 60, bShort: 1e5 });
  const alt = flat({ P: 4000, bShort: 1e5 });
  const universe = [marketOf("CUR", rows), marketOf("ALT", alt)];
  const strip = (d) => JSON.stringify({ action: d.action, reason: d.reason, hold: d.holdGrossUsd, sw: d.switchNetUsd, gain: d.gainUsd });
  const plain = decide({ position: posOf("CUR", 5000), rows, markets: universe, capitalAvailableUsd: 5000 });
  for (const pnl of [-9999, 0, 12345]) {
    const withPnl = decideExit({
      position: { ...posOf("CUR", 5000), realizedUsd: pnl, cumFunding: pnl, openedAtMs: 1, roundTripCost: 42 },
      rows, markets: universe, capitalAvailableUsd: 5000,
    });
    assert.equal(strip(withPnl), strip(plain), `решение сдвинулось от реализованного итога ${pnl}`);
  }
});

test("ВЕТКА КЭША ИНВАРИАНТНА К ГОРИЗОНТУ: она пользуется только знаком", () => {
  // Из этого и следует, что окно оценки у ветки кэша формально свободно. Замер отдельно показал,
  // что пользоваться этой свободой не стоит: короткое окно хуже по точности и по своевременности.
  const rows = flat({ P: 2000, bShort: 1e5, recv: "long" });
  const pos = posOf("T", 5000);
  const full = decide({ position: pos, rows, markets: [], capitalAvailableUsd: 5000 });
  const half = decide({ position: pos, rows, markets: [], capitalAvailableUsd: 5000, cfg: { ...FA_SIZING_DEFAULTS, horizonH: H / 2 } });
  assert.equal(full.action, "close");
  assert.equal(half.action, "close", "решение обязано совпасть");
  // А ВЕЛИЧИНА обязана измениться вдвое: иначе тест доказывал бы, что горизонт вообще не применился.
  near(half.holdGrossUsd / full.holdGrossUsd, 0.5, 0.02, "величина обязана быть пропорциональна окну");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Отложенные решения. Молчаливого исхода нет ни одного
// ─────────────────────────────────────────────────────────────────────────────

test("отказы снабжения и негодные входы называются, а не превращаются в «держим»", () => {
  const rows = flat({ P: 2000, bShort: 1e5 });
  const pos = posOf("T", 5000);
  const cases = [
    ["no_position", { position: null, rows, markets: [] }],
    ["no_position", { position: posOf("T", 0), rows, markets: [] }],
    ["short_history", { position: pos, rows: rows.slice(0, H - 1), markets: [] }],
    ["src_gmx_down", { position: pos, rows, markets: [], sources: { gmxDown: true } }],
    ["src_hl_down", { position: pos, rows, markets: [], sources: { hlDown: true } }],
    ["horizon_missing", { position: pos, rows, markets: [], cfg: { ...FA_SIZING_DEFAULTS, horizonH: 0 } }],
  ];
  for (const [want, args] of cases) {
    const d = decide(args);
    assert.equal(d.action, "defer", `${want}: обязан быть отложен`);
    assert.equal(d.reason, want);
    assert.equal(d.holdGrossUsd, null, `${want}: величины удержания при отложенном решении быть не может`);
  }
});

test("отказ источника СТАРШЕ данных: «альтернатив нет» не имеет права выглядеть как вывод правила", () => {
  // Без этого порядка молчание биржи давало бы «держим», то есть отказ снабжения выглядел бы
  // решением. Проверяется тем, что данные ПОЛНОЦЕННЫ, а исход всё равно отложен.
  const rows = flat({ P: 2000, bShort: 1e5 });
  const d = decide({ position: posOf("T", 5000), rows, markets: [marketOf("T", rows)], capitalAvailableUsd: 5000, sources: { gmxDown: true } });
  assert.equal(d.action, "defer");
  assert.equal(d.reason, "src_gmx_down");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Каданс решений
// ─────────────────────────────────────────────────────────────────────────────

test("каданс: первое решение разрешено всегда, дальше не чаще интервала", () => {
  const HOURMS = 3600e3;
  assert.equal(shouldDecideNow(null, 1e12, 24), true, "ещё не решали: разрешено");
  assert.equal(shouldDecideNow(undefined, 1e12, 24), true, "отсутствие метки это не ноль эпохи");
  assert.equal(shouldDecideNow(1e12, 1e12 + 23 * HOURMS, 24), false);
  assert.equal(shouldDecideNow(1e12, 1e12 + 24 * HOURMS, 24), true, "ровно интервал уже разрешает");
  assert.equal(shouldDecideNow(1e12, 1e12 + 25 * HOURMS, 24), true);
  assert.equal(shouldDecideNow(1e12, NaN, 24), false, "без времени решать нельзя");
  assert.equal(shouldDecideNow(1e12, 1e12 + HOURMS, 0), true, "нулевой интервал это решать всегда");
  // Значение по умолчанию замерено, а не назначено: 24 ч дают то же нетто, что 1 ч, за 29 кругов
  // вместо 46.
  assert.equal(FA_EXIT_DEFAULTS.decisionIntervalHours, 24);
  assert.equal(shouldDecideNow(1e12, 1e12 + 24 * HOURMS), true, "интервал по умолчанию");
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Реестры, журнал и изоляция от бота 2
// ─────────────────────────────────────────────────────────────────────────────

test("каждая причина реестра ДОСТИЖИМА, и достижимого вне реестра нет", () => {
  // Реестр без достижимости это обещание. Тесты выше копили наблюдённые причины в SEEN, и здесь
  // множества сверяются в обе стороны.
  const missing = FA_EXIT_REASONS.filter((r) => !SEEN.has(r));
  assert.deepEqual(missing, [], `причины реестра, которых ни один тест не получил: ${missing.join(", ")}`);
  const extra = [...SEEN].filter((r) => !FA_EXIT_REASONS.includes(r));
  assert.deepEqual(extra, [], `причины вне реестра: ${extra.join(", ")}`);
  assert.deepEqual([...FA_EXIT_ACTIONS], ["hold", "close", "switch", "defer"]);
});

test("журнал решения объясняет исход одной строкой и не падает ни на одной ветке", () => {
  const rich = flat({ P: 4000, bShort: 1e5 });
  const poor = flat({ P: 60, bShort: 1e5 });
  const pays = flat({ P: 2000, bShort: 1e5, recv: "long" });
  const pos = posOf("CUR", 5000);
  const sw = decideExit({ position: pos, rows: poor, markets: [marketOf("CUR", poor), marketOf("ALT", rich)], capitalAvailableUsd: 5000 });
  const hold = decideExit({ position: pos, rows: rich, markets: [marketOf("CUR", rich)], capitalAvailableUsd: 5000 });
  const close = decideExit({ position: pos, rows: pays, markets: [], capitalAvailableUsd: 5000 });
  const def = decideExit({ position: null, rows: rich, markets: [] });
  for (const [d, must] of [[sw, "ПЕРЕКЛАДКА"], [hold, "ДЕРЖИМ"], [close, "В КЭШ"], [def, "не решаем"]]) {
    const line = explainExit(d, pos);
    assert.ok(line.includes(must), `строка «${line}» обязана называть исход`);
    assert.ok(!line.includes("undefined") && !line.includes("NaN"), `дыра в строке: ${line}`);
  }
  assert.equal(explainExit(null), "решения нет");
  // Удержание без единой годной альтернативы обязано это ГОВОРИТЬ, а не молчать про альтернативы.
  const alone = decideExit({ position: pos, rows: rich, markets: [], capitalAvailableUsd: 5000 });
  assert.ok(explainExit(alone, pos).includes("годных альтернатив нет"));
});

test("замыкание импортов правила выхода НЕ пересекается с ботом 2", () => {
  // Бот 2 доведён до состояния, которое тестируется нетронутым, и у него идёт живой прогон.
  // Общий модуль между ботами это способ уронить второго правкой первого.
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*import[^"']*["'](\.[^"']+)["']/gm)) walk(join(dirname(file), m[1]));
  };
  walk(join(HERE, "..", "src", "engine", "fa", "exit.js"));
  const btc = [...seen].filter((f) => f.includes("btcopt"));
  assert.deepEqual(btc, [], `правило выхода тянет модули бота 2: ${btc.join(", ")}`);
  assert.ok(seen.size >= 5, "замыкание обязано быть непустым, иначе тест проверяет опечатку в пути");
  // Зависимость строго в одну сторону: правило ВХОДА не имеет права знать о правиле выхода, иначе
  // получился бы цикл, и «кто кого зовёт» перестало бы быть определено.
  const sizing = readFileSync(join(HERE, "..", "src", "engine", "fa", "sizing.js"), "utf8");
  assert.ok(!/from\s+["'][^"']*exit\.js["']/.test(sizing), "sizing.js не имеет права импортировать exit.js");
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Абсолютная величина на настоящих данных репозитория
// ─────────────────────────────────────────────────────────────────────────────

test("APT, BTC и ETH: решение и брутто удержания совпадают с замеренными числами", () => {
  // ЕДИНСТВЕННАЯ проверка правила, которая смотрит на АБСОЛЮТНУЮ величину. Синтетические рынки выше
  // проверяют форму критерия, но масштабная ошибка (единицы, множитель, поле другой размерности)
  // проходит их насквозь: оракул построен на тех же величинах.
  //
  // ТОЧЕК ДВЕ, И ВТОРАЯ ВАЖНЕЕ, ЧЕМ КАЖЕТСЯ. На часе 1440 правило ВХОДА не финансирует ни один из
  // трёх рынков, и правило выхода уходит в кэш; на часе 3600 один рынок проходит, и оно
  // перекладывается. Первая точка это единственный случай во всей охране, где ветка кэша срабатывает
  // на НАСТОЯЩИХ данных: на рабочем наборе из 63 рынков она не сработала ни разу за 8041 решение.
  const fx = join(HERE, "fixtures");
  const rowsOf = new Map();
  for (const t of ["APT", "BTC", "ETH"]) rowsOf.set(t, parseSpreadCsv(readFileSync(join(fx, `${t}.csv`), "utf8")));
  // Баз фандинга у фикстур нет, поэтому разбавление здесь не применяется вовсе: множитель равен
  // единице, и проверяется чистая арифметика начисления и выбора ветки. Разбавление стоит под своей
  // охраной, книгой `base-fa-dil.tsv`.
  const at = (hour0) => {
    const markets = [];
    for (const [token, rows] of rowsOf) {
      const trailing = rows.slice(hour0 - H, hour0);
      const config = scanTwoLeg(trailing, { token })?.chosen;
      markets.push({ token, config, strategy: "two", rows: trailing, live: { bOwnUsd: 1e12, bOtherUsd: 1e12 }, impact: null });
    }
    const held = markets.find((m) => m.token === "BTC");
    return decideExit({
      position: { token: "BTC", config: held.config, strategy: "two", sizeUsd: 2000 },
      rows: held.rows, markets, capitalAvailableUsd: 5000, costs: DEFAULT_COSTS,
    });
  };

  const cash = at(2 * H);
  assert.equal(cash.action, "close");
  assert.equal(cash.reason, "gross_negative");
  near(cash.holdGrossUsd, -12.312339, 1e-5, "брутто удержания BTC на $2000 за 720 ч");
  assert.deepEqual(cash.refusals.map((r) => r.refusal), ["negative_at_every_size", "negative_at_every_size", "negative_at_every_size"],
    "предусловие ветки кэша: правило входа обязано отказать ВСЕМ трём рынкам");

  const sw = at(3600);
  assert.equal(sw.action, "switch");
  assert.equal(sw.best.token, "APT");
  assert.equal(sw.best.config, "A");
  near(sw.holdGrossUsd, -3.208491, 1e-5, "брутто удержания BTC на часе 3600");
  near(sw.best.sizeUsd, 5000, 1e-9, "размер альтернативы связан потолком тикета");
  near(sw.best.netUsd, 137.423561, 1e-5, "нетто лучшей альтернативы");
  near(sw.gainUsd, 140.632053, 1e-5, "прибавка перекладки");
});
