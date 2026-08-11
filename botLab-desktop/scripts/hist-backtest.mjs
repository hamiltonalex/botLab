#!/usr/bin/env node
// hist-backtest.mjs - годовой проигрыш пресета по восстановленной истории. READ-ONLY, без сети.
//
// ВОПРОС, НА КОТОРЫЙ ЭТОТ СКРИПТ ОТВЕЧАЕТ, ровно один: **есть ли у правила входа преимущество ДО
// издержек, и что с ним делает моделируемая цена исполнения.** Всё устройство отчёта подчинено
// тому, чтобы эти две величины не смешались, потому что первая измерена, а вторая предположена.
//
// РАЗДЕЛЕНИЕ ИЗМЕРЕННОГО И ПРЕДПОЛОЖЕННОГО, и оно структурное, а не декларативное:
//   доход ДО издержек = (марк выхода − марк входа)/марк входа. Марк живёт на подогнанной
//     поверхности и от модели спреда НЕ ЗАВИСИТ ВООБЩЕ. Эта величина - замер.
//   доход ПОСЛЕ издержек = доход до издержек − круг издержек в % премии. Круг считает
//     computeTradeCosts по bid/ask, а bid/ask в истории МОДЕЛЬНЫЕ. Эта величина - допущение.
// Поэтому чувствительность к спреду двигает вторую строку и не может тронуть первую, что и
// печатается явным сравнением.
//
// ЕДИНИЦА СЧЁТА - ЭПИЗОД, А НЕ СТРОКА ЖУРНАЛА. Ловушка стоила проекту вымышленных «75% прибыльных»:
// получасовой кулдаун превратил один хороший вход в девять строк отчёта. Здесь на эпизод берётся
// РОВНО ОДИН вход - первый сигнал полосы, - и все проценты считаются по эпизодам.
//
// РАЗМЕР ВЫБОРКИ ПЕЧАТАЕТСЯ КАК n_eff, А НЕ КАК ЧИСЛО СДЕЛОК. Перекрывающиеся входы это одно
// наблюдение, записанное несколько раз: замер по записи прогона 5 дал корреляцию 0.90 при разрыве
// входов в полчаса и 5.9-14.3 независимых наблюдения на 72 часа. Метод оценки тот же, что в
// `eval:toll` (сумма автокорреляций с поправкой Бартлетта), чтобы числа были сравнимы.
//
// ЧЕГО ЭТОТ БЕКТЕСТ НЕ ЗНАЕТ, и это ограничивает вывод сильнее всего:
//   - стакана в истории нет, поэтому У12 идёт как `--depth assume`, а проскальзывание не
//     моделируется вовсе. Обе поправки двигают результат ПРОТИВ стратегии;
//   - спред снят с трёх спокойных августовских суток и разнесён на год (см. hist-cost.js);
//   - поверхность восстановлена с ошибкой около 0.6 пункта воли на инструмент (hist-validate.mjs).
//     Для СРЕДНЕГО по многим эпизодам эта ошибка усредняется, для одной сделки - нет.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SCAN_PRESETS } from "../src/engine/otmscan/presets.js";
import {
  indexSnapshot, evaluateReplayTick, replaySignals, toEpisodes,
  REPLAY_SETTINGS_DEFAULT, REPLAY_LOT, REPLAY_CONDITION_KEYS,
} from "../src/engine/otmscan/replay.js";
import { optionFeePct, computeTradeCosts } from "../src/engine/otmscan/economics.js";
import { computeSizing } from "../src/engine/otmscan/scan-engine.js";
import { evaluateExit } from "../src/engine/otmscan/exits.js";
import { mean, sd, nEff, ci95 } from "../src/engine/otmscan/stats.js";

const fin = (x) => Number.isFinite(x);
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const has = (n) => args.includes(n);

if (!argOf("--dir") && !argOf("--compare")) {
  console.error(`нужен --dir <каталог восстановления> либо --compare <метка=каталог,...>

  --preset <id>       пресет (по умолчанию measure-far-v1)
  --set k=v[,...]     переопределение полей пресета
  --settings k=v[,...] настройки: equityUsd, riskPerTradePct, cooldownSec, dwellTicks, nCandidatesMax
  --horizons <ч,...>  сроки удержания (по умолчанию 12,24,48)
  --episode-gap-min   разрыв, склеивающий такты в эпизод (по умолчанию 90; шаг записи 60)
  --depth assume|skip У12 без стакана (по умолчанию assume)
  --compare a=dir,... сравнить несколько восстановлений (чувствительность к модели издержек)
  --by-month          добавить помесячную разбивку
  --trades            печатать позиции по одной строке (вход, выход, P&L, значения условий)
  --trades-h <ч>      горизонт для таблицы позиций (по умолчанию первый из --horizons)
  --quotes modelled|measured  откуда bid/ask: модель hist-cost (восстановленная история, по
                      умолчанию) или живая запись прогона, где котировки настоящие
  --exits             вести позиции ПРАВИЛАМИ ВЫХОДА ПРЕСЕТА (Е1-Е7), а не фиксированным
                      горизонтом; печатает отдельный раздел, дефолтный вывод не меняет
  --exit k=v[,...]    переопределить поля выхода: takeProfitPct, stopLossPctPrem, timeStopH,
                      ivDropExitPts, minMoveSigma, preExpiryCloseH
  --exit-sweep        перебрать сетку правил выхода (тейк × стоп × тайм-стоп × падение воли)
                      ВНУТРИ одного запуска: запись грузится один раз, а не на каждую клетку
  --risk-sweep        перебрать риск на сделку при выбранных выходах: последовательная симуляция
                      счёта, вход отклоняется, если свободных денег не хватает`);
  process.exit(1);
}

const PRESET_ID = argOf("--preset", "measure-far-v1");
if (!SCAN_PRESETS[PRESET_ID]) { console.error(`неизвестный пресет ${PRESET_ID}`); process.exit(1); }
const parseKV = (s) => {
  const out = {};
  for (const part of (s ?? "").split(",")) {
    if (!part.trim()) continue;
    const [k, v] = part.split("=");
    if (!k || v === undefined) continue;
    const n = Number(v);
    out[k.trim()] = v === "true" ? true : v === "false" ? false : Number.isFinite(n) && v.trim() !== "" ? n : v.trim();
  }
  return out;
};
const OV = parseKV(argOf("--set"));
// Пресеты заморожены deepFreeze - строим НОВЫЙ объект, никогда не мутируем.
const P = { ...SCAN_PRESETS[PRESET_ID], exits: { ...SCAN_PRESETS[PRESET_ID].exits }, ...OV,
  id: `${PRESET_ID}${Object.keys(OV).length ? "*" : ""}` };
const S = { ...REPLAY_SETTINGS_DEFAULT, equityUsd: 500, ...parseKV(argOf("--settings")) };
const HORIZONS = (argOf("--horizons", "12,24,48")).split(",").map(Number).filter(fin);
const GAP_MS = Number(argOf("--episode-gap-min", "90")) * 60000;
const DEPTH = argOf("--depth", "assume");
const WANT_TRADES = has("--trades");
const TRADES_H = Number(argOf("--trades-h", String(HORIZONS[0])));
// Скрипт писался под восстановленную историю, где котировок нет и спред моделируется. По живой
// записи он тоже работает (hist-build отдаёт РОВНО формат живой записи), но там bid/ask настоящие,
// и печатать про них «модельные» значит соврать ровно в том месте, где живая запись и ценна.
const WANT_EXITS = has("--exits") || has("--exit-sweep") || has("--risk-sweep");
const WANT_EXIT_SWEEP = has("--exit-sweep");
const WANT_RISK_SWEEP = has("--risk-sweep");
const EXITS = { ...SCAN_PRESETS[PRESET_ID].exits, ...parseKV(argOf("--exit")) };
const QUOTES = argOf("--quotes", "modelled");
if (QUOTES !== "modelled" && QUOTES !== "measured") {
  console.error(`--quotes принимает только modelled или measured, получено "${QUOTES}"`);
  process.exit(1);
}
const QUOTES_MEASURED = QUOTES === "measured";
// Горизонт таблицы позиций обязан быть посчитан: row.h заполняется только для HORIZONS, поэтому
// чужой горизонт дал бы пустую таблицу с ложной причиной «за краем записи».
if (WANT_TRADES && !HORIZONS.includes(TRADES_H)) {
  console.error(`--trades-h ${TRADES_H} нет в --horizons ${HORIZONS.join(",")}: горизонт таблицы позиций должен быть среди считаемых`);
  process.exit(1);
}

// ── загрузка восстановления
function load(dir) {
  const D = existsSync(join(dir, "scan-records")) ? join(dir, "scan-records") : dir;
  const ticks = [];
  const snaps = new Map();
  for (const f of readdirSync(D).filter((x) => x.endsWith(".ndjson")).sort()) {
    const kind = f.includes("-ticks-") ? "t" : f.includes("-surface-") ? "s" : null;
    if (!kind) continue;
    for (const line of readFileSync(join(D, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (kind === "t") ticks.push(r);
      else {
        let m = snaps.get(r.ts);
        if (!m) { m = new Map(); snaps.set(r.ts, m); }
        m.set(r.n, r);
      }
    }
  }
  ticks.sort((a, b) => a.ts - b.ts);
  const times = [...snaps.keys()].sort((a, b) => a - b);
  return { ticks, snaps, times };
}

const q = (a, p) => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return null;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const f = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");


// ── один прогон: восстановление, эпизоды, доходности по горизонтам
function runOne(dir) {
  const { ticks, snaps, times } = load(dir);
  if (!ticks.length || !times.length) return null;
  const idxCache = new Map();
  const indexAt = (ts) => {
    let ix = idxCache.get(ts);
    if (!ix) { ix = indexSnapshot([...(snaps.get(ts)?.values() ?? [])]); if (idxCache.size > 600) idxCache.clear(); idxCache.set(ts, ix); }
    return ix;
  };
  const snapBefore = (ts) => { let lo = 0, hi = times.length - 1, res = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= ts) { res = m; lo = m + 1; } else hi = m - 1; } return res; };

  const evals = [];
  let hyst = null; // память гистерезиса: без протаскивания по циклу липкость выключена
  for (const t of ticks) {
    const si = snapBefore(t.ts);
    if (si < 0) continue;
    const e = evaluateReplayTick({ tick: t, index: indexAt(times[si]), preset: P, settings: S, depthMode: DEPTH, hyst });
    if (e) { hyst = e.hyst; evals.push(e); }
  }
  const signals = replaySignals(evals, S);
  // ЭПИЗОД СТРОИТСЯ ПО ТАКТАМ С ВЕРДИКТОМ, А НЕ ПО СТРОКАМ ЖУРНАЛА - так его определил аудит
  // 2026-08-08: «связная полоса тиков, где условия сошлись, при слиянии разрывов короче получаса».
  // Разница принципиальна именно на часовом кадансе: кулдаун 1800с короче шага записи и потому
  // не связывает ничего, а dwell в 3 такта означает уже не полторы минуты, как живьём, а три
  // ЧАСА. Считай мы эпизоды по строкам журнала, каждая строка стала бы «отдельным эпизодом»
  // просто потому, что данные разрежены, и выборка раздулась бы на ровном месте.
  const episodes = toEpisodes(evals.filter((e) => e.verdict), { gapMs: GAP_MS });
  // Одна ПОЗИЦИЯ на эпизод: вход в момент, когда внутри полосы впервые сработал бы движок
  // (то есть первый сигнал после dwell). Полоса короче dwell входа не даёт вовсе - это не потеря,
  // а честное «движок бы не успел».
  const sigByKey = new Map();
  for (const s of signals) {
    const k = `${s.best?.r?.n ?? "?"}|${s.side}`;
    if (!sigByKey.has(k)) sigByKey.set(k, []);
    sigByKey.get(k).push(s);
  }
  // Реализованная годовая волатильность индекса между двумя метками, по часовым логарифмическим
  // приращениям спота из строк тиков. Год = 365 суток - та же конвенция, что в rv.js и black76.js.
  const spotAt = ticks.filter((t) => fin(t.S)).map((t) => ({ ts: t.ts, s: t.S }));
  function realizedVolPctBetween(fromTs, toTs) {
    const win = spotAt.filter((p) => p.ts >= fromTs && p.ts <= toTs);
    if (win.length < 4) return null;
    const rets = [];
    for (let i = 1; i < win.length; i++) {
      const dtH = (win[i].ts - win[i - 1].ts) / 3600000;
      if (!(dtH > 0) || !(win[i].s > 0) || !(win[i - 1].s > 0)) continue;
      rets.push(Math.log(win[i].s / win[i - 1].s) / Math.sqrt(dtH)); // приводим к часовому шагу
    }
    if (rets.length < 3) return null;
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
    return Math.sqrt(v) * Math.sqrt(365 * 24) * 100;
  }

  const feeOf = (mark, index) => optionFeePct({ markUsd: mark, indexPrice: index }).feeUsd ?? 0;
  const trades = [];
  let epNoSignal = 0;
  for (const ep of episodes) {
    const s = (sigByKey.get(ep.key) ?? []).find((x) => x.ts >= ep.startTs && x.ts <= ep.endTs);
    if (!s) { epNoSignal += 1; continue; }
    const name = s.best?.r?.n;
    const i0 = snapBefore(s.ts);
    const r0 = snaps.get(times[i0])?.get(name);
    if (!r0 || !(r0.m > 0)) continue;
    const costs = computeTradeCosts({ markUsd: r0.m, bidUsd: r0.b, askUsd: r0.a, indexPrice: s.spot, execModel: P.execModel });
    const row = { ts: s.ts, name, epLen: ep.n, days: (r0.e - s.ts) / 86400000,
      delta: Math.abs(r0.d ?? NaN), ivEntry: r0.iv, markEntry: r0.m,
      rtcPct: costs?.roundTripCostPct ?? null, h: {},
      // Значения и состояния условий В МОМЕНТ ВХОДА: без них строка позиции не отвечает на вопрос
      // «при каких показаниях мы вошли», а именно он и задаётся при разборе каждой сделки.
      side: s.side, spot: s.spot, st: s.st, val: s.val, gateKeys: s.gateKeys,
      epStartTs: ep.startTs, epEndTs: ep.endTs };
    for (const H of HORIZONS) {
      const tgt = s.ts + H * 3600000;
      let j = i0 + 1;
      while (j < times.length && times[j] < tgt) j++;
      const r1 = j < times.length ? snaps.get(times[j])?.get(name) : null;
      if (!r1 || !(r1.m > 0)) { row.h[H] = null; continue; }
      const before = ((r1.m - r0.m) / r0.m) * 100;
      // РЕАЛИЗОВАННАЯ ВОЛЯ ЗА САМО УДЕРЖАНИЕ против IV, которую за неё заплатили. Это центральная
      // величина аудита 2026-08-08 («запас −0.53 пункта») и единственная, выраженная в тех же
      // единицах, что круг издержек. Считается по индексу из строк тика, час к часу.
      const rvHold = realizedVolPctBetween(s.ts, times[j]);
      row.h[H] = { before, after: before - (costs?.roundTripCostPct ?? 0), ivExit: r1.iv,
        heldH: (times[j] - times[i0]) / 3600000, exitTs: times[j], markExit: r1.m,
        dIv: fin(r1.iv) && fin(r0.iv) ? r1.iv - r0.iv : null,
        volEdge: fin(rvHold) && fin(r0.iv) ? rvHold - r0.iv : null };
    }
    // Контекст протяжки позиции: нужен, чтобы правила выхода можно было применить МНОГО раз
    // (перебор `--exit-sweep`) без перезагрузки записи. Сама протяжка ниже, в walkExit.
    row.i0 = i0;
    row.entryMark = r0.m;
    row.entryIv = r0.iv;
    row.s1d = s.s1d ?? null;
    trades.push(row);
  }
  // ── ПРОТЯЖКА ПОЗИЦИИ ДО ВЫХОДА ПО ПРАВИЛАМ ПРЕСЕТА (Е1-Е7).
  // Правило одно на проект и живёт в exits.js; здесь только подстановка величин снимка. Функция
  // возвращается наружу, чтобы перебор комбинаций выходов шёл без повторной загрузки записи.
  const walkExit = (t, exits) => {
    for (let j = t.i0 + 1; j < times.length; j++) {
      const r = snaps.get(times[j])?.get(t.name);
      if (!r || !(r.m > 0)) continue;
      const heldH = (times[j] - times[t.i0]) / 3600000;
      const movePct = fin(t.spot) && fin(r.f) ? ((r.f - t.spot) / t.spot) * 100 : null;
      const moveSigma = fin(movePct) && fin(t.s1d) && t.s1d > 0 ? Math.abs(movePct) / t.s1d : null;
      const ev = evaluateExit({ markUsd: r.m, entryMarkUsd: t.entryMark, ivPct: r.iv,
        entryIvPct: t.entryIv, heldH, hoursToExpiry: r.h, moveSigma, exits });
      const last = j === times.length - 1;
      if (!ev.exit && !last) continue;
      const before = ((r.m - t.entryMark) / t.entryMark) * 100;
      return { before, after: before - (t.rtcPct ?? 0), heldH, exitTs: times[j], markExit: r.m,
        reason: ev.reason ?? "конец записи" };
    }
    return null;
  };

  const spanH = (ticks.at(-1).ts - ticks[0].ts) / 3600000;
  const verdictTicks = evals.filter((e) => e.verdict).length;
  const stepMin = evals.length > 1 ? (evals[1].ts - evals[0].ts) / 60000 : null;
  return { evals, signals, episodes, trades, spanH, verdictTicks, epNoSignal, stepMin, ticks: evals.length, walkExit };
}

// ── отчёт
const COMPARE = argOf("--compare");
const runs = COMPARE
  ? COMPARE.split(",").map((p) => { const [label, dir] = p.split("="); return { label: label.trim(), dir: dir?.trim() }; })
  : [{ label: "база", dir: argOf("--dir") }];

const results = [];
for (const r of runs) {
  const out = runOne(r.dir);
  if (!out) { console.error(`пусто: ${r.dir}`); process.exit(1); }
  results.push({ ...r, ...out });
}
const A = results[0];

console.log(QUOTES_MEASURED
  ? `# Проигрыш пресета по живой записи прогона\n`
  : `# Годовой бектест по восстановленной истории\n`);
console.log(`Пресет \`${P.id}\` · окно экспираций ${P.expiryMinH}-${P.expiryMaxH} ч · отбор по ` +
  `${P.strikeMode === "delta" ? `дельте ${P.deltaMin}-${P.deltaMax}` : `σ ${P.sigmaMin}-${P.sigmaMax}`}`);
console.log(`Механика: dwell ${S.dwellTicks} · кулдаун ${S.cooldownSec}с · депозит $${S.equityUsd} · риск ${S.riskPerTradePct}% · лот ${REPLAY_LOT} BTC`);
console.log(`Запись: ${A.ticks} тактов, ${f(A.spanH / 24, 1)} суток` +
  ` (${new Date(A.evals[0].ts).toISOString().slice(0, 10)} .. ${new Date(A.evals.at(-1).ts).toISOString().slice(0, 10)})\n`);

console.log(`## 1 · Сколько нашлось, в правильных единицах\n`);
console.log(`| величина | значение |`);
console.log(`|---|---|`);
console.log(`| тактов с вердиктом (все гейты pass) | ${A.verdictTicks} (${f((100 * A.verdictTicks) / A.ticks, 1)}%) |`);
console.log(`| строк журнала (сигналов после dwell и кулдауна) | ${A.signals.length} |`);
console.log(`| **ЭПИЗОДОВ рынка** (полосы тактов, слияние разрывов ≤ ${GAP_MS / 60000} мин) | **${A.episodes.length}** |`);
console.log(`| из них короче dwell, входа не дали | ${A.epNoSignal} |`);
console.log(`| **ПОЗИЦИЙ (одна на эпизод)** | **${A.trades.length}** |`);
console.log(`| разных инструментов среди позиций | ${new Set(A.trades.map((t) => t.name)).size} |`);
console.log(`| тактов в эпизоде (медиана / p90) | ${f(q(A.episodes.map((e) => e.n), 0.5), 1)} / ${f(q(A.episodes.map((e) => e.n), 0.9), 1)} |`);
console.log(`| шаг записи | ${f(A.stepMin, 0)} мин |`);
console.log(`\nЭпизод считается по ТАКТАМ С ВЕРДИКТОМ, а не по строкам журнала: на часовом кадансе`);
console.log(`кулдаун в ${S.cooldownSec}с короче шага и не связывает ничего, поэтому каждая строка выглядела бы`);
console.log(`отдельной возможностью. На эпизод берётся ровно один вход.`);

console.log(`\n## 2 · ГЛАВНОЕ: преимущество ДО издержек\n`);
console.log(`Доход по маркам, без единой копейки издержек. От модели спреда эта таблица НЕ зависит.\n`);
console.log(`| горизонт | эпизодов | среднее | медиана | доля > 0 | ст.откл. | **n_eff** | полоса 95% для среднего |`);
console.log(`|---|---|---|---|---|---|---|---|`);
const beforeStats = {};
for (const H of HORIZONS) {
  const xs = A.trades.map((t) => t.h[H]?.before).filter(fin);
  if (!xs.length) { console.log(`| ${H} ч | 0 | н/д | н/д | н/д | н/д | н/д | н/д |`); continue; }
  const ne = nEff(xs);
  const m = mean(xs), s = sd(xs);
  const ci = fin(s) && fin(ne) && ne > 1 ? (1.96 * s) / Math.sqrt(ne) : null;
  beforeStats[H] = { m, ne, ci, n: xs.length };
  console.log(`| ${H} ч | ${xs.length} | **${f(m, 2)}%** | ${f(q(xs, 0.5), 2)}% | ${f((100 * xs.filter((x) => x > 0).length) / xs.length, 0)}% | ${f(s, 1)}% | **${f(ne, 1)}** | ±${f(ci, 2)}% |`);
}
console.log(`\nПолоса считается по n_eff, а не по числу эпизодов: перекрывающиеся входы не добавляют`);
console.log(`независимости, и деление на √n завысило бы уверенность.`);

console.log(`\n## 2b · То же в единицах волатильности, где живут и издержки\n`);
console.log(`Аудит 2026-08-08 свёл спор к одной паре чисел: круг издержек стоит **1.52 пункта воли**`);
console.log(`на сроке 8-16 дней и **0.62** на 32-64, а фактически реализовавшийся запас за трое суток`);
console.log(`августа был **−0.53 пункта**. Год даёт ту же величину на выборке в сотни раз большей.\n`);
console.log(`| горизонт | n | реализованная воля − IV входа, медиана | среднее | доля > 0 | изменение IV, медиана |`);
console.log(`|---|---|---|---|---|---|`);
for (const H of HORIZONS) {
  const ve = A.trades.map((t) => t.h[H]?.volEdge).filter(fin);
  const di = A.trades.map((t) => t.h[H]?.dIv).filter(fin);
  if (!ve.length) continue;
  console.log(`| ${H} ч | ${ve.length} | **${f(q(ve, 0.5), 2)} п.п.** | ${f(mean(ve), 2)} п.п. | ${f((100 * ve.filter((x) => x > 0).length) / ve.length, 0)}% | ${f(q(di, 0.5), 2)} п.п. |`);
}
console.log(`\nЧитать так: положительная величина означает, что рынок отработал больше воли, чем за неё`);
console.log(`заплатили. Сравнивать её надо не с нулём, а с кругом издержек.`);
console.log(`\n**Разделы 2 и 2b мерят РАЗНОЕ, и путать их нельзя.** Раздел 2 это то, что получает`);
console.log(`покупатель БЕЗ хеджа: там результат почти целиком движение цены, и аудит уже показал, что`);
console.log(`дельта объясняет 81% дисперсии итога. Раздел 2b это то, что получил бы покупатель`);
console.log(`С ДЕЛЬТА-ХЕДЖЕМ, то есть чистая ставка на волатильность. Первое около нуля, второе`);
console.log(`уверенно отрицательно - и вместе они говорят ровно то, что сказал аудит структурно:`);
console.log(`позиция направленная, а чеклист фильтрует волатильность.`);
console.log(`\n> Оговорка к оценке: реализованная воля за 12 часов считается по дюжине часовых приращений,`);
console.log(`> поэтому оценка шумная и её МЕДИАНА смещена вниз относительно среднего (распределение`);
console.log(`> выборочного σ скошено). Опираться следует на среднее, а не на медиану.`);

console.log(`\n## 3 · Что с ним делает ${QUOTES_MEASURED ? "ИЗМЕРЕННАЯ" : "МОДЕЛИРУЕМАЯ"} цена исполнения\n`);
console.log(QUOTES_MEASURED
  ? `Круг издержек вычитается из каждой позиции. Это ЗАМЕР: bid/ask взяты из живой записи рынка.\n`
  : `Круг издержек вычитается из каждой позиции. Это ДОПУЩЕНИЕ (истории котировок нет).\n`);
console.log(`| горизонт | среднее до издержек | круг, % премии (медиана) | среднее после | доля > 0 после |`);
console.log(`|---|---|---|---|---|`);
for (const H of HORIZONS) {
  const bef = A.trades.map((t) => t.h[H]?.before).filter(fin);
  const aft = A.trades.map((t) => t.h[H]?.after).filter(fin);
  if (!aft.length) continue;
  console.log(`| ${H} ч | ${f(mean(bef), 2)}% | ${f(q(A.trades.map((t) => t.rtcPct), 0.5), 2)}% | **${f(mean(aft), 2)}%** | ${f((100 * aft.filter((x) => x > 0).length) / aft.length, 0)}% |`);
}

// ── позиции по одной строке. Проценты печатаются те же, что посчитаны выше; размер позиции берётся
// у живого `computeSizing`, а не заводится здесь. Собственного правила проигрыша тут нет - это тот
// класс дефекта, который назван в шапке replay.js.
// ОГОВОРКА, которую надо знать при сравнении отчётов: долларовый итог ЗДЕСЬ и в `eval:preset` считан
// по разным соглашениям об исполнении. Здесь обе ноги по марку, а круг издержек вычитается целиком
// (computeTradeCosts); там обе ноги по середине книги и берутся только комиссии. На одной и той же
// сделке расхождение доходит до полутора процентных пунктов, и это не расхождение данных.
if (WANT_TRADES) {
  const H = fin(TRADES_H) ? TRADES_H : HORIZONS[0];
  const rows = A.trades.filter((t) => t.h[H]);
  const dropped = A.trades.length - rows.length;
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  console.log(`\n## 3b · Позиции по одной строке (горизонт ${H} ч)\n`);
  console.log(`Одна строка = один эпизод = одна позиция. Выход здесь один и тот же для всех - `
    + `фиксированный горизонт ${H} ч, ближайший снимок не раньше него; правила выхода самого пресета `
    + `(тейк, стоп, падение воли) в этом расчёте НЕ применяются.`);
  if (dropped) console.log(`Позиций без выхода внутри записи (горизонт за её краем): ${dropped} из ${A.trades.length}.`);
  console.log();
  // Размер позиции берётся из ЖИВОГО правила `computeSizing`, а не из одного минимального лота:
  // при депозите $500 и риске 20% движок купил бы три-четыре лота, и долларовый итог по одному
  // лоту занизил бы результат втрое. Проценты от премии от размера не зависят, доллары зависят.
  const sizeOf = (t) => computeSizing({ markUsd: t.markEntry, lot: REPLAY_LOT, equityUsd: S.equityUsd,
    riskPerTradePct: S.riskPerTradePct, qtyMax: S.qtyMax, entryDepthUsd: null, maxQtyDepthPct: P.maxQtyDepthPct });
  console.log(`| № | вход UTC | инструмент | сторона | до эксп., д | дельта | IV входа | лотов | вложено $ | выход UTC | держали, ч | до издержек, % | круг, % | после издержек, % | P&L $ | на суб-счёт $${S.equityUsd}, % |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  let pnlTotal = 0;
  rows.forEach((t, i) => {
    const h = t.h[H];
    const qty = sizeOf(t).qtySuggested ?? REPLAY_LOT;
    const stakeUsd = t.markEntry * qty;
    const pnlUsd = stakeUsd * (h.after / 100);
    pnlTotal += pnlUsd;
    console.log(`| ${i + 1} | ${stamp(t.ts)} | ${t.name.replace("BTC_USDC-", "")} | ${t.side} | ${f(t.days, 1)} | `
      + `${f(t.delta, 2)} | ${f(t.ivEntry, 1)} | ${Math.round(qty / REPLAY_LOT)} | ${f(stakeUsd, 2)} | `
      + `${stamp(h.exitTs)} | ${f(h.heldH, 1)} | ${f(h.before, 2)} | ${f(t.rtcPct, 2)} | **${f(h.after, 2)}** | `
      + `${f(pnlUsd, 2)} | ${f((pnlUsd / S.equityUsd) * 100, 3)} |`);
  });
  if (rows.length) {
    console.log(`\nИтог по закрытым позициям: **${f(pnlTotal, 2)} $ на суб-счёте $${S.equityUsd} = `
      + `${f((pnlTotal / S.equityUsd) * 100, 2)}%**. Размер каждой позиции даёт \`computeSizing\` `
      + `(депозит $${S.equityUsd}, риск ${S.riskPerTradePct}%), а не один минимальный лот.`);
  }
  if (rows.length) {
    const aft = rows.map((t) => t.h[H].after);
    const bef = rows.map((t) => t.h[H].before);
    const ne = nEff(aft);
    console.log(`\n| итог по ${rows.length} позициям | до издержек | после издержек |`);
    console.log(`|---|---|---|`);
    console.log(`| **среднее** | **${f(mean(bef), 2)}%** | **${f(mean(aft), 2)}%** |`);
    console.log(`| медиана | ${f(q(bef, 0.5), 2)}% | ${f(q(aft, 0.5), 2)}% |`);
    console.log(`| доля прибыльных | ${f((100 * bef.filter((x) => x > 0).length) / bef.length, 0)}% | ${f((100 * aft.filter((x) => x > 0).length) / aft.length, 0)}% |`);
    console.log(`| худшая | ${f(Math.min(...bef), 2)}% | ${f(Math.min(...aft), 2)}% |`);
    console.log(`| лучшая | ${f(Math.max(...bef), 2)}% | ${f(Math.max(...aft), 2)}% |`);
    console.log(`| **n_eff** | ${f(ne, 1)} | ${f(ne, 1)} |`);
    console.log(`\n**Среднее и медиана расходятся по построению, и платит среднее.** Тесный правый край`);
    console.log(`с длинным левым хвостом даёт высокую долю прибыльных при отрицательном среднем: замер`);
    console.log(`аудита 2026-08-08 давал медиану +7.9% и 56% прибыльных при среднем −5.7%.`);
  }

  console.log(`\n### Значения условий в момент входа\n`);
  console.log(`Гейты помечены звёздочкой: все они по построению \`pass\`, иначе позиции бы не было.`);
  console.log(`Остальные строки чеклиста идут в режиме info и вход не блокируют - их значения здесь`);
  console.log(`ровно для того, чтобы было видно, ПРИ КАКОМ рынке сработал вход.\n`);
  const head = REPLAY_CONDITION_KEYS.map((k) => (A.trades[0]?.gateKeys?.includes(k) ? `${k}*` : k));
  console.log(`| № | вход UTC | ${head.join(" | ")} |`);
  console.log(`|---|---|${REPLAY_CONDITION_KEYS.map(() => "---").join("|")}|`);
  rows.forEach((t, i) => {
    const cells = REPLAY_CONDITION_KEYS.map((k) => (fin(t.val?.[k]) ? f(t.val[k], 2) : (t.st?.[k] ?? "н/д")));
    console.log(`| ${i + 1} | ${stamp(t.ts)} | ${cells.join(" | ")} |`);
  });
}

if (results.length > 1) {
  console.log(`\n## 4 · Чувствительность к модели издержек\n`);
  console.log(`Столбец «до издержек» обязан быть ОДИНАКОВ во всех строках, где менялась только`);
  console.log(`модель спреда: если он поехал, значит спред просочился туда, где его быть не должно.\n`);
  console.log(`| вариант | эпизодов | круг, % премии | среднее до издержек (${HORIZONS[0]}ч) | среднее после (${HORIZONS[0]}ч) |`);
  console.log(`|---|---|---|---|---|`);
  const H = HORIZONS[0];
  for (const r of results) {
    const bef = r.trades.map((t) => t.h[H]?.before).filter(fin);
    const aft = r.trades.map((t) => t.h[H]?.after).filter(fin);
    console.log(`| ${r.label} | ${r.episodes.length} | ${f(q(r.trades.map((t) => t.rtcPct), 0.5), 2)}% | ${f(mean(bef), 2)}% | **${f(mean(aft), 2)}%** |`);
  }
}

if (has("--by-month")) {
  console.log(`\n## 5 · По месяцам (горизонт ${HORIZONS[0]}ч)\n`);
  console.log(`| месяц | эпизодов | среднее до издержек | среднее после | медиана IV входа |`);
  console.log(`|---|---|---|---|---|`);
  const H = HORIZONS[0];
  const byM = new Map();
  for (const t of A.trades) {
    const k = new Date(t.ts).toISOString().slice(0, 7);
    if (!byM.has(k)) byM.set(k, []);
    byM.get(k).push(t);
  }
  for (const k of [...byM.keys()].sort()) {
    const g = byM.get(k);
    console.log(`| ${k} | ${g.length} | ${f(mean(g.map((t) => t.h[H]?.before)), 2)}% | ${f(mean(g.map((t) => t.h[H]?.after)), 2)}% | ${f(q(g.map((t) => t.ivEntry), 0.5), 1)} |`);
  }
}

// ── ВЫХОДЫ ПРЕСЕТА: то, ради чего заведён `--exits`. Это первый расчёт проекта, где позиция
// закрывается ПРАВИЛОМ БОТА, а не секундомером, то есть первая честная попытка ответить «сколько
// заработал бы движок целиком». До сих пор всё мерилось при фиксированном удержании, потому что
// правила выхода были только числами в пресете: фаза S4 не начата, живой бот их не исполняет.
if (WANT_EXITS) {
  for (const t of A.trades) t.ex = A.walkExit(t, EXITS);
  // ── ОГРАНИЧЕНИЕ ДВИЖКА НА ОДНОВРЕМЕННЫЕ ПОЗИЦИИ. Без него расчёт отвечает на вопрос «что дало бы
  // правило выхода», а не «что заработал бы движок»: правила выхода растягивают удержание, позиции
  // начинают перекрываться, и их среднее число доходит до величин, которые в счёт физически не
  // помещаются (6.3 позиции по 20% риска это 125% депозита). Движок в такой ситуации просто НЕ
  // ОТКРЫВАЕТ лишние: берёт первую и блокирует остальные до освобождения слота. Это не поправка
  // на бумаге, а то самое правило, которое поедет в бой, поэтому применяется здесь же.
  const MAXC = Math.max(1, Number(S.maxConcurrent) || 1);
  const open = [];
  let blocked = 0;
  for (const t of A.trades.filter((x) => x.ex).sort((a, b) => a.ts - b.ts)) {
    while (open.length && open[0] <= t.ts) open.shift();
    if (open.length >= MAXC) { t.blocked = true; blocked += 1; continue; }
    open.push(t.ex.exitTs);
    open.sort((a, b) => a - b);
  }
  const rowsAll = A.trades.filter((t) => t.ex);
  const rows = rowsAll.filter((t) => !t.blocked);
  if (blocked) {
    console.log(`> Ограничение движка на одновременные позиции (maxConcurrent ${MAXC}) сняло ${blocked} входов`);
    console.log(`> из ${rowsAll.length}: слот был занят. Ниже считаются только те, что движок реально открыл бы.`);
    const bAll = mean(rowsAll.map((t) => t.ex.after)), bOk = mean(rows.map((t) => t.ex.after));
    console.log(`> Без ограничения среднее после издержек было бы ${f(bAll)}%, с ограничением ${f(bOk)}%.\n`);
  }
  console.log(`\n## 6 · Прибыль по ПРАВИЛАМ ВЫХОДА пресета (Е1-Е7)\n`);
  console.log(`Тейк +${EXITS.takeProfitPct}% · стоп −${EXITS.stopLossPctPrem}% · падение воли ${EXITS.ivDropExitPts} п.п. · `
    + `тайм-стоп ${EXITS.timeStopH} ч при движении менее ${EXITS.minMoveSigma}σ · закрытие за ${EXITS.preExpiryCloseH} ч до экспирации.\n`);
  if (!rows.length) { console.log(`Ни одна позиция не дожила до выхода внутри записи.`); }
  else {
    const bef = rows.map((t) => t.ex.before), aft = rows.map((t) => t.ex.after);
    const held = rows.map((t) => t.ex.heldH);
    const mB = mean(bef), mA = mean(aft), neB = nEff(bef), neA = nEff(aft);
    console.log(`| величина | значение |`);
    console.log(`|---|---|`);
    console.log(`| позиций ОТКРЫТО движком (лимит ${MAXC} одновременных) | ${rows.length} из ${A.trades.length} |`);
    console.log(`| среднее ДО издержек | **${f(mB)}%** ± ${f(ci95(bef, neB))}% (n_eff ${f(neB, 1)}) |`);
    console.log(`| среднее ПОСЛЕ издержек | **${f(mA)}%** ± ${f(ci95(aft, neA))}% |`);
    console.log(`| медиана после издержек | ${f(q(aft, 0.5))}% |`);
    console.log(`| доля прибыльных после издержек | ${f((aft.filter((x) => x > 0).length / aft.length) * 100, 0)}% |`);
    console.log(`| удержание, медиана / p90 | ${f(q(held, 0.5), 1)} / ${f(q(held, 0.9), 1)} ч |`);
    const by = new Map();
    for (const t of rows) by.set(t.ex.reason, (by.get(t.ex.reason) ?? 0) + 1);
    console.log(`\n| причина выхода | сколько | доля | среднее после издержек |`);
    console.log(`|---|---|---|---|`);
    for (const [why, n] of [...by.entries()].sort((a, b) => b[1] - a[1])) {
      const sub = rows.filter((t) => t.ex.reason === why).map((t) => t.ex.after);
      console.log(`| ${why} | ${n} | ${f((n / rows.length) * 100, 0)}% | ${f(mean(sub))}% |`);
    }
    // ДЕНЬГИ. Размер даёт живой `computeSizing`, а не один минимальный лот.
    const sizeOf = (t) => computeSizing({ markUsd: t.markEntry, lot: REPLAY_LOT, equityUsd: S.equityUsd,
      riskPerTradePct: S.riskPerTradePct, qtyMax: S.qtyMax, entryDepthUsd: null, maxQtyDepthPct: P.maxQtyDepthPct });
    let pnl = 0, staked = 0;
    for (const t of rows) {
      const qty = sizeOf(t).qtySuggested ?? REPLAY_LOT;
      const stake = t.markEntry * qty;
      staked += stake; pnl += stake * (t.ex.after / 100);
    }
    // ДЕНЬГИ НАДО ПОДАВАТЬ ОСТОРОЖНО. Сумма P&L по 1113 ПОСЛЕДОВАТЕЛЬНЫМ сделкам, отнесённая к
    // статичному депозиту, даёт бессмысленные «минус сотни процентов»: счёт обнулился бы задолго до
    // конца года, и дальше торговать было бы нечем. Поэтому печатается средняя сделка в долларах и
    // отдельно судьба счёта при реинвестировании, а не одна суммарная цифра.
    const avgStake = staked / rows.length, avgPnl = pnl / rows.length;
    let eq = S.equityUsd, ruinAt = null;
    for (let k = 0; k < rows.length; k++) {
      const t = rows[k];
      eq *= 1 + (S.riskPerTradePct / 100) * (t.ex.after / 100);
      if (eq < S.equityUsd * 0.01 && ruinAt == null) { ruinAt = k + 1; break; }
    }
    console.log(`\n**Деньги: средняя сделка ${f(avgPnl)} $ при средней ставке ${f(avgStake)} $.**`);
    console.log(`Суммарно ${f(pnl)} $ по ${rows.length} позициям, но складывать их в одну цифру нельзя:`);
    console.log(`позиции последовательные, и счёт по дороге меняется. Реинвестирование при риске`);
    console.log(`${S.riskPerTradePct}% на сделку: депозит $${S.equityUsd} ${ruinAt ? `падает ниже 1% от начального на ${ruinAt}-й сделке` : `приходит к $${f(eq)} к концу года`}.`);
    // ХВОСТ И ПРОСАДКА. Без них средняя доходность не говорит ничего: выключенный стоп улучшает
    // среднее ровно тем, что перестаёт резать убыток, и цену этого надо показать отдельно.
    const worst = rows.reduce((a, t) => (t.ex.after < a.ex.after ? t : a), rows[0]);
    let peak = S.equityUsd, eq2 = S.equityUsd, maxDd = 0;
    for (const t of rows) {
      eq2 *= 1 + (S.riskPerTradePct / 100) * (t.ex.after / 100);
      peak = Math.max(peak, eq2);
      maxDd = Math.max(maxDd, (peak - eq2) / peak);
    }
    console.log(`\n| хвост и просадка | значение |`);
    console.log(`|---|---|`);
    console.log(`| худшая сделка | ${f(worst.ex.after)}% (${worst.name.replace("BTC_USDC-", "")}, держали ${f(worst.ex.heldH, 1)} ч) |`);
    console.log(`| 5% худших, среднее | ${f(mean(rows.map((t) => t.ex.after).sort((a, b) => a - b).slice(0, Math.max(1, Math.round(rows.length * 0.05)))))}% |`);
    console.log(`| максимальная просадка счёта при риске ${S.riskPerTradePct}% | ${f(maxDd * 100, 1)}% |`);
    // ПО МЕСЯЦАМ: та же проверка, которая убила предыдущего кандидата свипа входа.
    const byM = new Map();
    for (const t of rows) {
      const m = new Date(t.ts).toISOString().slice(0, 7);
      if (!byM.has(m)) byM.set(m, []);
      byM.get(m).push(t.ex.after);
    }
    const months = [...byM.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    console.log(`\n| месяц | позиций | среднее после издержек |`);
    console.log(`|---|---|---|`);
    for (const [m, a] of months) console.log(`| ${m} | ${a.length} | ${f(mean(a))}% |`);
    const tot = rows.length, sum = rows.reduce((x, t) => x + t.ex.after, 0);
    const top3 = months.map(([m, a]) => ({ m, n: a.length, s: a.reduce((x, y) => x + y, 0) }))
      .sort((x, y) => y.s - x.s).slice(0, 3);
    const drop = (names) => { const k = rows.filter((t) => !names.includes(new Date(t.ts).toISOString().slice(0, 7)));
      return k.length ? mean(k.map((t) => t.ex.after)) : null; };
    console.log(`\nТри лучших месяца дают ${f((top3.reduce((x, y) => x + y.s, 0) / sum) * 100, 0)}% итога при `
      + `${f((top3.reduce((x, y) => x + y.n, 0) / tot) * 100, 0)}% сделок. `
      + `Без лучшего месяца среднее ${f(drop([top3[0].m]))}%, без двух ${f(drop(top3.slice(0, 2).map((x) => x.m)))}%, `
      + `без трёх ${f(drop(top3.map((x) => x.m)))}%.`);
    console.log(`\n> Полоса считается по n_eff, а не по числу позиций. Правила выхода СОКРАЩАЮТ перекрытие`);
    console.log(`> входов, поэтому n_eff здесь выше, чем при фиксированном удержании, но независимых`);
    console.log(`> наблюдений всё равно меньше, чем строк.`);
  }
}

// ── ПЕРЕБОР ПРАВИЛ ВЫХОДА. Это и есть попытка ВЫЖАТЬ прибыль из уже найденных входов: вход не
// меняется вовсе, меняется только то, когда мы закрываемся. Запись загружена один раз, поэтому
// сетка в сотни клеток считается за минуты, а не за полтора часа.
if (WANT_EXIT_SWEEP) {
  const TPs = [10, 15, 20, 30, 50, 90];
  const SLs = [20, 35, 50, 99];
  const TSs = [4, 8, 12, 24, 48];
  const IVDs = [1.5, 3, 999];
  const out = [];
  for (const tp of TPs) for (const sl of SLs) for (const ts of TSs) for (const ivd of IVDs) {
    const X = { ...EXITS, takeProfitPct: tp, stopLossPctPrem: sl, timeStopH: ts, ivDropExitPts: ivd };
    const res = A.trades.map((t) => A.walkExit(t, X)).filter(Boolean);
    if (!res.length) continue;
    const aft = res.map((x) => x.after), bef = res.map((x) => x.before);
    const ne = nEff(aft);
    out.push({ tp, sl, ts, ivd, n: res.length, before: mean(bef), after: mean(aft),
      ci: ci95(aft, ne), nEff: ne, win: (aft.filter((x) => x > 0).length / aft.length) * 100,
      heldMed: q(res.map((x) => x.heldH), 0.5) });
  }
  out.sort((a, b) => b.after - a.after);
  console.log(`\n## 7 · Перебор правил выхода: попытка выжать прибыль из тех же входов\n`);
  console.log(`Клеток ${out.length} (тейк × стоп × тайм-стоп × падение воли). Вход НЕ меняется.\n`);
  console.log(`| # | тейк | стоп | тайм-стоп | пад.воли | позиций | до изд. | **после изд.** | полоса 95% | приб. | держали, ч |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);
  out.slice(0, 15).forEach((r, i) => {
    console.log(`| ${i + 1} | +${r.tp}% | −${r.sl}% | ${r.ts} ч | ${r.ivd === 999 ? "выкл" : r.ivd + " п."} | ${r.n} | `
      + `${f(r.before)}% | **${f(r.after)}%** | ±${f(r.ci)}% | ${f(r.win, 0)}% | ${f(r.heldMed, 1)} |`);
  });
  const pos = out.filter((r) => r.after > 0);
  const surv = pos.filter((r) => r.after > r.ci);
  console.log(`\n**Клеток с положительным средним после издержек: ${pos.length} из ${out.length}.**`);
  console.log(`Из них выходят за собственную полосу 95%: **${surv.length}**.`);
  console.log(`\n> Клеток ${out.length}, поэтому на уровне 95% около ${Math.round(out.length * 0.05)} обязаны выглядеть`);
  console.log(`> удачными случайно. Сырое первое место в этой таблице не значит ничего без проверки на`);
  console.log(`> половинах года и по месяцам.`);
}

// ── ПЕРЕБОР РИСКА НА СДЕЛКУ. Здесь моделируется НАСТОЯЩЕЕ ограничение движка, и это не счётчик
// позиций: `maxConcurrent` в движке не ограничивает ничего, он входит только в справочную метрику
// «комфортный капитал» (economics.js). Реально движок упирается в ДЕНЬГИ - `computeSizing` режет
// размер по риску от текущего счёта и про уже открытые позиции не знает вовсе, поэтому при
// длинных удержаниях свободных средств просто не остаётся и вход не состоится.
// Симуляция последовательная и честная: счёт растёт и падает на закрытых сделках, размер каждой
// новой позиции считается от ТЕКУЩЕГО счёта, вход отклоняется, если свободных денег не хватает.
if (WANT_RISK_SWEEP) {
  const all = A.trades.filter((t) => t.ex).sort((a, b) => a.ts - b.ts);
  console.log(`\n## 8 · Риск на сделку: во что упирается движок\n`);
  console.log(`Выходы: тейк +${EXITS.takeProfitPct}% · стоп −${EXITS.stopLossPctPrem}% · падение воли ${EXITS.ivDropExitPts} п.п. · тайм-стоп ${EXITS.timeStopH} ч.`);
  console.log(`Симуляция последовательная: счёт меняется на закрытых сделках, вход без свободных денег не состоится.\n`);
  console.log(`| капитал | риск на сделку | входов взято | из них | среднее после изд. | полоса 95% | счёт к концу года | макс. просадка |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  const EQS = (argOf("--equity-grid") ?? String(S.equityUsd)).split(",").map(Number).filter(fin);
  const RISKS = (argOf("--risk-grid") ?? "2,3,5,7,10,15,20").split(",").map(Number).filter(fin);
  for (const EQ0 of EQS) for (const risk of RISKS) {
    let eq = EQ0, peak = eq, maxDd = 0;
    const open = []; // { exitTs, stake, pnl }
    const taken = [];
    for (const t of all) {
      while (open.length && open[0].exitTs <= t.ts) { const o = open.shift(); eq += o.pnl;
        peak = Math.max(peak, eq); maxDd = Math.max(maxDd, (peak - eq) / peak); }
      const used = open.reduce((x, o) => x + o.stake, 0);
      const free = eq - used;
      const sz = computeSizing({ markUsd: t.markEntry, lot: REPLAY_LOT, equityUsd: eq,
        riskPerTradePct: risk, qtyMax: S.qtyMax, entryDepthUsd: null, maxQtyDepthPct: P.maxQtyDepthPct });
      const qty = sz.ok ? sz.qtySuggested : null;
      if (!qty) continue;
      const stake = t.markEntry * qty;
      if (stake > free) continue; // денег нет: движок физически не откроет
      open.push({ exitTs: t.ex.exitTs, stake, pnl: stake * (t.ex.after / 100) });
      open.sort((a, b) => a.exitTs - b.exitTs);
      taken.push(t);
    }
    while (open.length) { const o = open.shift(); eq += o.pnl;
      peak = Math.max(peak, eq); maxDd = Math.max(maxDd, (peak - eq) / peak); }
    if (!taken.length) { console.log(`| $${EQ0} | ${risk}% | 0 | ${all.length} | н/д | н/д | н/д | н/д |`); continue; }
    const aft = taken.map((t) => t.ex.after);
    const ne = nEff(aft);
    console.log(`| $${EQ0} | ${risk}% | **${taken.length}** | ${all.length} | ${f(mean(aft))}% | ±${f(ci95(aft, ne))}% | `
      + `**$${f(eq)}** (${f(((eq / EQ0) - 1) * 100, 0)}%) | ${f(maxDd * 100, 1)}% |`);
  }
  console.log(`\n> Счёт в предпоследнем столбце это ИТОГ последовательной симуляции, а не сумма процентов.`);
  console.log(`> Полоса в третьем столбце относится к средней сделке, а не к итогу счёта: по одной`);
  console.log(`> реализации пути доверительный интервал итога не считается вовсе.`);
}

console.log(`\n## Границы этого расчёта\n`);
console.log(QUOTES_MEASURED
  ? `- bid/ask ИЗМЕРЕНЫ: котировки взяты из живой записи прогона, раздел 3 здесь не допущение, а замер.`
  : `- bid/ask МОДЕЛЬНЫЕ: истории котировок Deribit не хранит. Раздел 2 от них не зависит, раздел 3 зависит целиком.`);
console.log(`- Стакана нет: У12 идёт как \`--depth ${DEPTH}\`, проскальзывание не моделируется. Обе поправки против стратегии.`);
if (!QUOTES_MEASURED) {
  console.log(`- Поверхность восстановлена из ленты с ошибкой около 0.6 пункта воли на инструмент (hist-validate).`);
  console.log(`  Для среднего по десяткам эпизодов она усредняется, для одной сделки - нет.`);
}
console.log(`- n_eff меряется по одной траектории, поэтому это порядок величины, а не точность.`);
