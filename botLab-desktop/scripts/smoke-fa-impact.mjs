#!/usr/bin/env node
// smoke-fa-impact.mjs - КРИВАЯ УДАРА GMX В ЖИВОМ ТРАКТЕ, ОФЛАЙН. В сеть НЕ ходит, в охрану не
// входит.
//
// ЧТО ЭТОТ СМОУК ОТВЕЧАЕТ, И ЗАЧЕМ ОН ОТДЕЛЬНО ОТ ТЕСТА. Тест среза проверяет ФОРМУ (узлы есть,
// источник назван), а здесь видно ЧИСЛО: какой удар достаётся каждому инструменту живого состава,
// откуда взялась его кривая и во что это обходится кругу издержек. Пока правка не сделана, ответ
// на оба вопроса один и тот же - «плоские 0.1%», - и отличить его от измеренной кривой глазами
// нельзя ничем, кроме такого вывода.
//
// ПОЧЕМУ ОФЛАЙН, ХОТЯ ПРЕДМЕТ ЖИВОЙ. Состав берётся из фикстур отбора (`markets-info-*.json`,
// `hl-meta.json`), то есть из тех же файлов, на которых стоит числовая приёмка фазы 3. Живой
// прогон дал бы другой состав на каждом запуске (три замера одного дня 16.09 дали 49, 48 и 46
// рынков), и смоук, зашивший живое число, был бы непроверяем. Сеть здесь ничего бы не добавила:
// кривая удара живьём не наблюдаема вовсе (в REST GMX нет ни одного поля impact), она ВСЕГДА
// приходит из снимка, и проверять надо путь снимка до правила, а не путь сети до снимка.
//
// ЧЕГО ЭТОТ СМОУК НЕ ДЕЛАЕТ. Не считает доходность: рядов ставок у фикстур отбора нет, экономику
// на трёх годовых фикстурах меряет книга правила входа (`replay-funding-size.mjs`, у неё для этого
// есть контроль `--drop-rule impact-off`).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FA_UNIVERSE_DEFAULTS, selectUniverse, resolveUniverse, schemeOf } from "../src/engine/fa/universe-scan.js";
import { ALL_MARKETS } from "../src/engine/universe.js";
import { buildFaSlice } from "../src/engine/fa/slice.js";
import { legModel } from "../src/engine/paper.js";
import { costAtSize, interpBps, FA_SIZING_DEFAULTS } from "../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../src/engine/costs.js";
import { makeImpactCurve } from "../src/main/impact-load.js";
import { IMPACT_SHELF_LIFE_DAYS, impactSnapshotAge } from "../src/engine/fa/impact-curve.js";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

if (args.includes("--help")) {
  console.log(`smoke-fa-impact.mjs - кривая удара GMX в живом тракте (офлайн)

  --ticket <$>   размер, на котором показывается удар (по умолчанию 2500, тикет отбора)
  --at <ISO>     момент отбора для ворот возраста (по умолчанию 2026-09-16T10:33Z)`);
  process.exit(0);
}

const TICKET = Number(argOf("--ticket", String(FA_UNIVERSE_DEFAULTS.ticketUsd)));
const AT = Date.parse(argOf("--at", "2026-09-16T10:33:00Z"));
const FX = join(APP, "test", "fixtures");
const fx = (n) => JSON.parse(readFileSync(join(FX, n), "utf8"));

const scan = selectUniverse({
  marketsByChain: { arbitrum: fx("markets-info-arbitrum.json").markets, avalanche: fx("markets-info-avalanche.json").markets },
  hlCoins: fx("hl-meta.json").universe,
  cfg: { ...FA_UNIVERSE_DEFAULTS },
  asOfMs: AT,
});
const instruments = resolveUniverse({ scan, saved: null, fallback: ALL_MARKETS, held: [] }).instruments;

const curve = makeImpactCurve();
// СРОК ГОДНОСТИ МЕРИТСЯ ПО НАСТОЯЩИМ ЧАСАМ, а не по `--at`: `--at` это момент отбора для ворот
// возраста фикстуры, а вопрос здесь другой, годен ли снимок СЕГОДНЯ. Юнит-тесты возраст проверяют
// поданным числом и настоящих часов не касаются: тест, протухающий вместе со снимком, ронял бы
// охрану в день, который никто не выбирал. Смоук в охрану не входит, и падать ему тут можно.
const age = impactSnapshotAge({ periodEndMs: curve.periodEndMs, nowMs: Date.now() });
const day = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "н-д");
if (curve.error) console.log(`! снимок глубины не прочитан: ${curve.error}\n`);
else {
  console.log(`снимок глубины: ${curve.markets} рынков, цепь ${curve.chain}`);
  console.log(`период до ${day(curve.periodEndMs)}, возраст ${age.days == null ? "неизвестен" : `${age.days.toFixed(0)} сут`}, срок годности ${IMPACT_SHELF_LIFE_DAYS} сут (до ${day(curve.periodEndMs + IMPACT_SHELF_LIFE_DAYS * 86400e3)})${age.stale ? " - ПРОСРОЧЕН" : ""}\n`);
}

// СРЕЗ СТРОИТСЯ ТОЙ ЖЕ СКЛАДКОЙ, ЧТО У ЖИВОГО БОТА. Снимок и стакан здесь пустые: предмет смоука
// это кривая удара, а ворота данных отсеяли бы каждую строку и показывать стало бы нечего.
const slice = buildFaSlice({
  instruments, nowMs: AT, gmxAt: AT, windowH: FA_SIZING_DEFAULTS.horizonH,
  snapshotOf: () => null, bookOf: () => null, rowsOf: () => [],
  impactOf: curve.impactOf,
});

console.log(`| инструмент | цепь | схема | сторона | источник | удар, бп | круг $${TICKET} | без кривой |`);
console.log(`|---|---|---|---|---|---|---|---|`);
const tally = {};
const rows = [];
for (const m of slice) {
  const inst = instruments.find((i) => i.key === m.token);
  const { gmxSide } = legModel(m.strategy, m.config);
  const src = m.live.gmxCurveSrc;
  tally[src] = (tally[src] || 0) + 1;
  const bps = m.impact.gmxNodes.length ? interpBps(m.impact.gmxNodes, TICKET) : NaN;
  const isOne = m.strategy === "one";
  const withCurve = costAtSize({ sizeUsd: TICKET, costs: DEFAULT_COSTS, impact: m.impact, isOneLeg: isOne });
  const without = costAtSize({ sizeUsd: TICKET, costs: DEFAULT_COSTS, impact: { gmxNodes: [], hlNodes: m.impact.hlNodes }, isOneLeg: isOne });
  rows.push({ key: m.token, chain: inst?.chain, scheme: m.strategy, gmxSide, src, bps, withCurve, without });
}
rows.sort((a, b) => (a.src < b.src ? -1 : a.src > b.src ? 1 : a.key < b.key ? -1 : 1));
for (const r of rows) {
  console.log(`| ${r.key} | ${r.chain} | ${r.scheme} | ${r.gmxSide} | ${r.src} | ${Number.isFinite(r.bps) ? r.bps.toFixed(3) : "н-д"} | ${r.withCurve.toFixed(4)} | ${r.without.toFixed(4)} |`);
}

const named = rows.filter((r) => r.src !== "none");
const dCirc = rows.reduce((s, r) => s + (r.without - r.withCurve), 0);
console.log(`\nисточники кривой: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(", ")} (всего ${slice.length})`);
console.log(`ненулевой удар у ${named.filter((r) => Number.isFinite(r.bps) && r.bps > 0).length} инструментов из ${slice.length}`);
console.log(`круг издержек при $${TICKET}: с кривой дешевле на $${dCirc.toFixed(2)} по всему составу (плоская константа ${DEFAULT_COSTS.gmxImpact}% завышает удар)`);

// ПРОВАЛ СМОУКА ЭТО ПРОВАЛ КОДА ВОЗВРАТА, а не строчка в выводе: смоук, который «сообщает» о
// поломке нулевым кодом, отличается от отсутствующего только длиной вывода.
if (curve.error) { console.error(`\nПРОВАЛ: снимок глубины не прочитан`); process.exit(1); }
// ПРОСРОЧКА РОНЯЕТ СМОУК, И ЭТО ВЕСЬ «ПОСЛЕ СРОКА» В КОДЕ. Живой бот считает по тому же снимку и
// говорит о возрасте строкой журнала и полем `im` записи решения, потому что обе замены измерены и
// обе хуже: плоская константа ошибается в медиане на 10.00 бп против 0.07 у яруса, а отказ рынку
// без своей кривой снимает 31% вселенной. Но срок, о котором никто не узнает, отличается от
// отсутствующего только длиной шапки, поэтому узнаёт о нём тот, кто гоняет смоук.
if (age.stale) {
  console.error(`\nПРОВАЛ: снимок просрочен (возраст ${age.days == null ? "неизвестен" : `${age.days.toFixed(0)} сут`} при сроке ${IMPACT_SHELF_LIFE_DAYS}). Пересчитать снимок глубины, а до тех пор знать, что запасная кривая стареет первой и на тесных рынках недооценивает удар.`);
  process.exit(1);
}
if (!named.length) { console.error(`\nПРОВАЛ: ни одному инструменту не досталось кривой`); process.exit(1); }
if (!tally.market) { console.error(`\nПРОВАЛ: своя кривая рынка не досталась никому`); process.exit(1); }
