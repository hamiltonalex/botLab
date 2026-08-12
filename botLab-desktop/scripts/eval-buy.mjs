#!/usr/bin/env node
// eval-buy.mjs — что дали бы сделки ПОКУПКИ опционов от входа до выхода. READ-ONLY, без сети.
//
// ЗАЧЕМ. Весь предыдущий анализ упирался во вход: сколько раз условия сошлись. Вопрос «какую
// доходность это дало бы» лежит ЗА входом, а там у нас пусто — правила выхода в пресете написаны,
// но ни разу не исполнялись, потому что ни одного сигнала не родилось. Этот скрипт закрывает разрыв:
// открывает позицию по заданному правилу входа и ведёт её по записи до срабатывания выхода.
//
// ЧТО СЧИТАЕТСЯ ЧЕСТНО:
//   - вход по лучшему кандидату того тика, как выбрал бы движок;
//   - переоценка по снимкам поверхности (5 мин), то есть по реальным ценам того момента;
//   - издержки обеих сторон: комиссия 0.0003 индекса с кэпом 12.5% премии плюс спред по модели
//     исполнения (по умолчанию тейкерская, то есть пессимистичная: покупаем по аску, продаём по биду);
//   - выходы из пресета: тейк-профит, стоп по премии, тайм-стоп, предэкспирационное закрытие,
//     vega-стоп по падению подразумеваемой волатильности.
//
// ЧЕГО ЭТОТ РАСЧЁТ НЕ ДАЁТ. Десяток сделок за трое суток статистикой не является. Он отвечает на
// другой, более узкий и более важный сейчас вопрос: СЪЕДАЮТ ли издержки и временной распад тот
// доход, который приносит движение цены. Ответ на него виден уже на десятке сделок, потому что это
// вопрос про арифметику одной сделки, а не про распределение исходов.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SCAN_PRESETS } from "../src/engine/otmscan/presets.js";
import { optionFeePct } from "../src/engine/otmscan/economics.js";
import { evaluateExit } from "../src/engine/otmscan/exits.js";

const fin = (x) => Number.isFinite(x);
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const DIR = argOf("--dir");
if (!DIR) { console.error("нужен --dir <каталог с scan-records>"); process.exit(1); }
const RECS = existsSync(join(DIR, "scan-records")) ? join(DIR, "scan-records") : DIR;
const EXEC = argOf("--exec", "taker");
const QTY = Number(argOf("--qty", 0.01));
const DWELL = Number(argOf("--dwell", 3));
const COOLDOWN_S = Number(argOf("--cooldown", 1800));
const IMPULSE = Number(argOf("--impulse", 0.5));
const EDGE = Number(argOf("--edge", 0));      // минимальный запас недооценки, п.п. (0 = просто RV выше IV)
const TP = Number(argOf("--tp", NaN));
const TS = Number(argOf("--timestop", NaN));  // тайм-стоп, ч (по умолчанию из пресета)        // тейк-профит, % (по умолчанию из пресета)

const load = (kind) => {
  const out = [];
  for (const f of readdirSync(RECS).filter((x) => x.includes(`-${kind}-`) && x.endsWith(".ndjson"))) {
    for (const line of readFileSync(join(RECS, f), "utf8").split("\n")) {
      if (line.trim()) { try { out.push(JSON.parse(line)); } catch {} }
    }
  }
  return out;
};
const ticks = load("ticks").sort((a, b) => a.ts - b.ts);
const surf = load("surface");
const snaps = new Map();
for (const r of surf) { if (!snaps.has(r.ts)) snaps.set(r.ts, new Map()); snaps.get(r.ts).set(r.n, r); }
const times = [...snaps.keys()].sort((a, b) => a - b);
const spanH = (ticks.at(-1).ts - ticks[0].ts) / 3600000;

const P = SCAN_PRESETS["delta-v1"];
const X = P.exits;
const f = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");
const q = (a, p) => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return null;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };

// ── ПРАВИЛО ВХОДА, которое я считаю содержательным после чистки чеклиста.
// Оставлено ровно два рыночных вопроса: есть ли преимущество (реализованная воля выше
// подразумеваемой) и есть ли движение (импульс). Плюс все шесть гейтов КАЧЕСТВА инструмента,
// которые в записи проходят 99.6-100% и потому ничего не отбирают, а страхуют от плохого входа.
// Выброшены: запас недооценки в 5 п.п. (дублирует первый вопрос более сильным порогом), короткая
// волатильность (шумная версия того же), ближняя против дальней (не сработала ни разу за 144 часа),
// совпадение с трендом (задаёт сторону, а не решает, торговать ли).
const buyEntry = (t) => {
  const V = t.V || {}, St = t.St || "";
  const edge = fin(V["У1"]) ? V["У1"] >= EDGE : St[0] === "p";       // преимущество не меньше порога
  const move = fin(V["У4"]) ? V["У4"] >= IMPULSE : St[3] === "p";     // движение есть
  const quality = [8, 9, 10, 11, 12, 13].every((i) => St[i] === "p"); // качество инструмента
  return edge && move && quality && t.B && t.B.n;
};

// ── Отбор входов с механикой движка: DWELL тиков подряд, потом кулдаун.
const entries = [];
{
  let run = 0, until = 0;
  for (const t of ticks) {
    if (!buyEntry(t)) { run = 0; continue; }
    run += 1;
    if (run >= DWELL && t.ts >= until) { entries.push(t); until = t.ts + COOLDOWN_S * 1000; run = 0; }
  }
}

const feeUsd = (mark, index) => optionFeePct({ markUsd: mark, indexPrice: index }).feeUsd ?? 0;
const buyPx = (r) => (EXEC === "mid" ? (fin(r.md) ? r.md : r.m) : fin(r.a) ? r.a : r.m);
const sellPx = (r) => (EXEC === "mid" ? (fin(r.md) ? r.md : r.m) : fin(r.b) ? r.b : r.m);

// ── Ведение позиции до выхода по правилам пресета.
const TP_EFF = fin(TP) ? TP : X.takeProfitPct;
const TS_EFF = fin(TS) ? TS : X.timeStopH;
function runTrade(t, timeStopH = TS_EFF, tpPct = TP_EFF) {
  const name = t.B.n;
  let i = times.findIndex((x) => x >= t.ts);
  if (i < 0) return null;
  const r0 = snaps.get(times[i])?.get(name);
  if (!r0 || !fin(r0.m)) return null;
  const entryPx = buyPx(r0);
  if (!fin(entryPx) || entryPx <= 0) return null;
  const index0 = t.S ?? r0.f;
  const cost0 = feeUsd(r0.m, index0) * QTY;
  const paid = entryPx * QTY + cost0;
  const ivIn = r0.iv, s1d = t.s1d ?? null, fwd0 = r0.f ?? null;
  // Триггеры тейка и стопа СРАБАТЫВАЮТ по mark, как их определяет пресет (EXITS_DEFAULT:
  // «mark ≥ entry·(1+x/100)»), а исполняются по стороне книги. Сравнивать бид с аском нельзя:
  // на спреде 4.3% премии «тейк +10%» превратился бы в требование роста mark на 14.3%, то есть
  // симулятор проверял бы не то правило, которое написано в пресете и поедет в S4.
  const entryMark = r0.m;

  for (let j = i + 1; j < times.length; j++) {
    const r = snaps.get(times[j])?.get(name);
    if (!r || !fin(r.m)) continue;
    const heldH = (times[j] - times[i]) / 3600000;
    const px = sellPx(r);
    const gross = px * QTY;
    const cost1 = feeUsd(r.m, r.f) * QTY;
    const pnl = gross - cost1 - paid;
    // Форвард к форварду ОДНОЙ экспирации, а не форвард к споту: спот входа отличается от
    // форварда на базис (медиана 0.435% на 28-56 днях против σ1d 2.078%, то есть 0.21σ при
    // пороге minMoveSigma 0.1σ), и тайм-стоп срабатывал бы не там, где написано в пресете.
    const movePct = fin(fwd0) && fin(r.f) ? ((r.f - fwd0) / fwd0) * 100 : null;
    const moveSigma = fin(movePct) && fin(s1d) && s1d > 0 ? Math.abs(movePct) / s1d : null;

    // Правило выхода одно на проект и живёт в exits.js (Е1-Е7). Здесь только подстановка величин
    // и переопределения тейка/тайм-стопа, которыми свипует этот скрипт.
    const ev = evaluateExit({ markUsd: r.m, entryMarkUsd: entryMark, ivPct: r.iv, entryIvPct: ivIn,
      heldH, hoursToExpiry: r.h, moveSigma,
      exits: { ...X, takeProfitPct: tpPct, timeStopH } });
    let why = ev.reason;
    if (!why && j === times.length - 1) why = "конец записи";
    if (why) {
      return { ts: t.ts, name, why, heldH, paid, pnl, entryPx, exitPx: px,
        retPct: (pnl / paid) * 100, costPct: ((cost0 + cost1) / paid) * 100,
        movePct, delta: t.V?.["У9"] ?? null, days: (t.B.e - t.ts) / 86400000,
        thetaIn: t.B.th ?? null, premPctSpot: t.B.pr ?? null };
    }
  }
  return null;
}

const trades = entries.map((e) => runTrade(e)).filter(Boolean);

console.log(`# Сделки покупки: от входа до выхода\n`);
console.log(`Запись: ${ticks.length} тиков, ${f(spanH, 1)} ч. Исполнение ${EXEC === "mid" ? "по середине" : "тейкерское (пессимистичное)"}, размер ${QTY} BTC.`);
console.log(`\n**Правило входа:** запас недооценки ≥ ${EDGE} п.п. + импульс ≥ ${IMPULSE}σ + шесть гейтов качества инструмента.`);
console.log(`Выброшены как избыточные или неработающие: запас недооценки 5 п.п., короткая воля, ближняя против дальней, совпадение с трендом.`);
console.log(`\n**Выходы** из пресета: тейк +${TP_EFF}%, стоп −${X.stopLossPctPrem}%, падение воли на ${X.ivDropExitPts} п.п., тайм-стоп ${TS_EFF} ч при движении менее ${X.minMoveSigma}σ, закрытие за ${X.preExpiryCloseH} ч до экспирации.\n`);

if (!trades.length) { console.log(`Сделок нет: правило входа за эту запись не сработало.`); process.exit(0); }

console.log(`## Итог\n`);
const wins = trades.filter((t) => t.pnl > 0);
const sum = trades.reduce((s, t) => s + t.pnl, 0);
const paid = trades.reduce((s, t) => s + t.paid, 0);
console.log(`| показатель | значение |`);
console.log(`|---|---|`);
console.log(`| сделок | **${trades.length}** |`);
console.log(`| прибыльных | ${wins.length} (${f(100 * wins.length / trades.length, 0)}%) |`);
console.log(`| суммарный результат | **$${f(sum)}** на вложенные $${f(paid)} |`);
console.log(`| доходность на вложенное | **${f((sum / paid) * 100, 1)}%** |`);
console.log(`| средняя сделка | $${f(sum / trades.length)} (${f(q(trades.map((t) => t.retPct), .5), 1)}% медиана) |`);
console.log(`| лучшая / худшая | +${f(Math.max(...trades.map((t) => t.retPct)), 1)}% / ${f(Math.min(...trades.map((t) => t.retPct)), 1)}% |`);
console.log(`| издержки круга | ${f(q(trades.map((t) => t.costPct), .5), 1)}% от вложенного |`);
console.log(`| среднее удержание | ${f(q(trades.map((t) => t.heldH), .5), 1)} ч |`);
const byWhy = trades.reduce((a, t) => ((a[t.why] = (a[t.why] || 0) + 1), a), {});
console.log(`| причины выхода | ${Object.entries(byWhy).map(([k, v]) => `${k} ${v}`).join(" · ")} |`);

console.log(`\n## Сколько нужно движения, чтобы выйти в ноль\n`);
const bePct = trades.map((t) => (fin(t.delta) && fin(t.premPctSpot) && t.premPctSpot > 0
  ? (t.costPct / 100) * t.premPctSpot / Math.abs(t.delta) : null));
console.log(`Издержки круга ${f(q(trades.map((t) => t.costPct), .5), 1)}% премии, распад ${f(q(trades.map((t) => t.thetaIn), .5), 1)}% премии в сутки.`);
console.log(`При дельте ${f(q(trades.map((t) => t.delta), .5), 2)} и премии ${f(q(trades.map((t) => t.premPctSpot), .5), 2)}% от цены BTC это значит:`);
console.log(`\n- окупить издержки: движение BTC на **${f(q(bePct, .5), 3)}%** в нужную сторону;`);
const thDay = q(trades.map((t) => t.thetaIn), .5), prem = q(trades.map((t) => t.premPctSpot), .5), dl = q(trades.map((t) => t.delta), .5);
const perDay = fin(thDay) && fin(prem) && fin(dl) ? (thDay / 100) * prem / Math.abs(dl) : null;
console.log(`- окупить распад: **${f(perDay, 3)}%** за каждые сутки удержания.`);
const s1dMed = q(ticks.map((t) => t.s1d), .5);
console.log(`\nДля масштаба: суточное стандартное отклонение BTC в этой записи ${f(s1dMed, 2)}%, то есть на окупаемость`);
console.log(`нужно около **${f((q(bePct, .5) + (perDay ?? 0)) / s1dMed, 2)}σ** движения за первые сутки.`);

// ── ДИАГНОСТИКА: отделить «плохой вход» от «плохого выхода» от «рынок не двигался».
// Для каждого входа считаем ЛУЧШИЙ достижимый выход (с полным знанием будущего). Если даже он в
// минусе — виноват вход или рынок, и правила выхода тут ни при чём. Если он в хорошем плюсе, а наш
// фактический результат в минусе — виноваты правила выхода.
console.log(`\n## Виноват вход, выход или рынок?\n`);
{
  const ideal = [];
  for (const t of entries) {
    const name = t.B.n;
    let i = times.findIndex((x) => x >= t.ts);
    const r0 = i >= 0 ? snaps.get(times[i])?.get(name) : null;
    if (!r0 || !fin(r0.m)) continue;
    const entryPx = buyPx(r0);
    const paid = entryPx * QTY + feeUsd(r0.m, t.S ?? r0.f) * QTY;
    let best = -Infinity, bestH = null;
    for (let j = i + 1; j < times.length; j++) {
      const r = snaps.get(times[j])?.get(name);
      if (!r || !fin(r.m)) continue;
      const pnl = sellPx(r) * QTY - feeUsd(r.m, r.f) * QTY - paid;
      if (pnl > best) { best = pnl; bestH = (times[j] - times[i]) / 3600000; }
    }
    if (fin(best)) ideal.push({ ret: (best / paid) * 100, h: bestH });
  }
  if (ideal.length) {
    const pos = ideal.filter((x) => x.ret > 0).length;
    console.log(`| | наш фактический выход | ЛУЧШИЙ возможный выход |`);
    console.log(`|---|---|---|`);
    console.log(`| медиана результата | ${f(q(trades.map((t) => t.retPct), .5), 1)}% | **${f(q(ideal.map((x) => x.ret), .5), 1)}%** |`);
    console.log(`| прибыльных | ${f(100 * wins.length / trades.length, 0)}% | **${f(100 * pos / ideal.length, 0)}%** |`);
    console.log(`| лучшая | ${f(Math.max(...trades.map((t) => t.retPct)), 1)}% | **${f(Math.max(...ideal.map((x) => x.ret)), 1)}%** |`);
    console.log(`| когда наступал максимум | — | через ${f(q(ideal.map((x) => x.h), .5), 1)} ч |`);
    console.log(`\nЛучший возможный выход посчитан с полным знанием будущего: это верхняя граница того,`);
    console.log(`что можно было выжать из ЭТИХ входов на ЭТОМ рынке любыми правилами выхода.`);
  }
}

// ── Чувствительность к тайм-стопу: он закрыл большинство позиций.
console.log(`\n## Что дал бы другой тайм-стоп\n`);
console.log(`| тайм-стоп | сделок | медиана результата | прибыльных |`);
console.log(`|---|---|---|---|`);
// Метку «сейчас» ставим ДЕЙСТВУЮЩЕМУ тайм-стопу (пресет либо --timestop), а не зашитому числу:
// с `--timestop 24` прежняя версия помечала текущей строку 12 ч и противоречила собственной шапке.
for (const H of [...new Set([4, 6, 12, 24, 48, TS_EFF])].sort((a, b) => a - b)) {
  const tt = entries.map((e) => runTrade(e, H)).filter(Boolean);
  if (!tt.length) continue;
  console.log(`| ${H} ч${H === TS_EFF ? " (сейчас)" : ""} | ${tt.length} | ${f(q(tt.map((t) => t.retPct), .5), 1)}% | ${f(100 * tt.filter((t) => t.pnl > 0).length / tt.length, 0)}% |`);
}

// ── Тейк-профит: он писался под ДАЛЬНИЕ страйки, где выплата лотерейная, и не пересматривался,
// когда отбор переехал к деньгам. При дельте 0.4 рост премии на 90% это огромное событие, а
// достижимый максимум по этим входам около 17%. Проверяем, насколько это и есть причина.
// ГОЧА, стоившая целой таблицы: колонки были зашиты как 6 и 12 ч, поэтому при `--timestop 24`
// тайм-стоп срабатывал раньше любого тейка и ВСЕ строки выходили одинаковыми - таблица выглядела
// как «тейк ни на что не влияет», хотя она просто мерила тайм-стоп. Берём действующий тайм-стоп и
// колонку без него: только так видно, что делает сам тейк.
console.log(`\n## Тейк-профит: он не пересматривался при переезде к деньгам\n`);
console.log(`| тейк-профит | тайм-стоп ${f(TS_EFF, 0)} ч | без тайм-стопа |`);
console.log(`|---|---|---|`);
for (const tp of [10, 15, 20, 30, 50, 90]) {
  const row = [TS_EFF, Infinity].map((H) => {
    const tt = entries.map((e) => runTrade(e, H, tp)).filter(Boolean);
    if (!tt.length) return "н/д";
    const sum = tt.reduce((s, t) => s + t.pnl, 0), paid = tt.reduce((s, t) => s + t.paid, 0);
    const w = tt.filter((t) => t.pnl > 0).length;
    return `${f((sum / paid) * 100, 1)}% · прибыльных ${f(100 * w / tt.length, 0)}%`;
  });
  console.log(`| +${tp}%${tp === X.takeProfitPct ? " (сейчас)" : ""} | ${row[0]} | ${row[1]} |`);
}

console.log(`\n## Все сделки\n`);
console.log(`| вход | инструмент | дельта | срок | держали | выход | результат |`);
console.log(`|---|---|---|---|---|---|---|`);
for (const t of trades) {
  console.log(`| ${new Date(t.ts).toISOString().slice(5, 16).replace("T", " ")} | ${t.name.replace("BTC_USDC-", "")} | ${f(t.delta, 2)} | ${f(t.days, 1)}д | ${f(t.heldH, 1)} ч | ${t.why} | **${f(t.retPct, 1)}%** |`);
}

console.log(`\n> Десяток сделок за трое суток статистикой не является. Этот расчёт отвечает на другой,`);
console.log(`> более узкий вопрос: съедают ли издержки и распад тот доход, который даёт движение цены.`);
console.log(`> Ответ на него виден уже на десятке, потому что это арифметика одной сделки.`);
