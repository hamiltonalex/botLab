#!/usr/bin/env node
// eval-preset.mjs — офлайн-проигрыш ЛЮБОГО пресета по записи прогона. READ-ONLY, без сети.
//
// ЗАЧЕМ. Обещание записи ("любой набор порогов проверяется задним числом за минуты") до сих пор
// выполнялось наполовину: report:scan считает то, что реально считал движок, eval:relax крутит два
// условия, eval:buy берёт ОДНОГО записанного лучшего кандидата тика. Ни один из них не отвечает на
// вопрос "что дал бы ДРУГОЙ пресет", потому что при другом окне экспираций меняется сам набор
// кандидатов, а значит и IV_ref, и крылья, и вся инструментная группа У9-У14.
//
// Здесь набор восстанавливается из записи поверхности целиком, повторяя тракт снабжения main.js:
//   near-экспирация  = первая в окне пресета            (buildScanSet)
//   far-экспирация   = первая из ВСЕХ листингов ≥ fivFarMinDays суток
//   IV_ref           = среднее mark_iv ATM-пары near     (deriveScanIvRef)
//   far-IV           = то же для far, отсюда У6
//   крылья ±1σ       = страйки ближе всего к S·(1±σ_T)   (У7)
//   кандидаты        = selectCandidates: окно, сито σ, сортировка по возрастанию σ-дистанции,
//                      срез nCandidatesMax; гейт в режиме delta — |Δ| живых греков
// Условия У1-У14 считаются теми же формулами, что conditions.js, по тем же пресетным порогам.
//
// ЧТО ЭТО НЕ ЗАМЕНЯЕТ. Прогон по записи проверяет ЛОГИКУ пресета на прошлом рынке. Он не
// доказывает доходность: независимых наблюдений в трёхсуточной записи порядка десяти (npm run
// eval:toll, раздел 3), и подбор порогов до появления сделок на такой выборке есть подгонка.
// Инструмент отвечает на вопрос "родится ли вообще сигнал и во что мы войдём", а не "сколько
// заработаем".
//
// ТРИ МЕСТА, ГДЕ ОФЛАЙН ЧЕСТНО ОТЛИЧАЕТСЯ ОТ ЖИВОГО ТРАКТА, и все три печатаются в отчёте:
//   1. цены инструментов берутся из снимка поверхности (каданс 300с, фактически до 332с), тогда
//      как живой движок видел тикеры каждые 30с. Снимок берётся строго НЕ ПОЗЖЕ тика.
//   2. У12 (глубина книги) в поверхности отсутствует: стаканы забираются только финалистам. Режим
//      по умолчанию --depth assume — условие считается пройденным, и доля таких тиков печатается.
//   3. IV_ref по экспирациям офлайн известен ТОЧНО для каждой (ATM-пара есть в поверхности), тогда
//      как живой сборщик знал его только для near и подставлял DVOL остальным.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SCAN_PRESETS } from "../src/engine/otmscan/presets.js";
import { optionFeePct } from "../src/engine/otmscan/economics.js";
// Правила проигрыша живут в ОДНОМ месте и переиспользуются историческим бектестом (см. шапку
// replay.js): две копии одного правила — тот класс дефекта, который проект ловил уже трижды.
import {
  indexSnapshot, evaluateReplayTick, replaySignals, REPLAY_LOT, REPLAY_CONDITION_KEYS,
} from "../src/engine/otmscan/replay.js";

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;
const YEAR_MS = 365 * 86400000;

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const has = (n) => args.includes(n);
const DIR = argOf("--dir");
if (!DIR) {
  console.error(`нужен --dir <каталог с scan-records>

  --preset <id>          база: dmitri-v1 | dmitri-v2 | delta-v1 | calibrated (по умолчанию delta-v1)
  --set k=v[,k=v...]     переопределение пресетных полей, напр. expiryMaxH=768,premMaxPct=6
  --settings k=v[,...]   переопределение настроек: dwellTicks, cooldownSec, nCandidatesMax,
                         equityUsd, riskPerTradePct, ttlSec
  --depth assume|skip    У12 без стакана: считать пройденным (по умолчанию) или unknown
  --exec taker|mid       модель исполнения сделок (по умолчанию из пресета execModel)
  --trades               вести сделки от входа до выхода и печатать их
  --trades-max N         сколько строк сделок печатать (по умолчанию 40)
  --quiet                только сводка`);
  process.exit(1);
}
const RECS = existsSync(join(DIR, "scan-records")) ? join(DIR, "scan-records") : DIR;
const DEPTH_MODE = argOf("--depth", "assume");
const WANT_TRADES = has("--trades");
// Отчёт по обкатке обязан показать КАЖДУЮ сделку, а не первые сорок: обрезка молча превращает
// «все входы» в «начало выборки», и по такому хвосту нельзя ни свериться, ни возразить.
const TRADES_MAX = Number(argOf("--trades-max", "40"));
const QUIET = has("--quiet");

// ── пресет и настройки: пресет заморожен deepFreeze, поэтому строим НОВЫЙ объект
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
const BASE_ID = argOf("--preset", "delta-v1");
if (!SCAN_PRESETS[BASE_ID]) { console.error(`неизвестный пресет ${BASE_ID}`); process.exit(1); }
const OV = parseKV(argOf("--set"));
const P = { ...SCAN_PRESETS[BASE_ID], exits: { ...SCAN_PRESETS[BASE_ID].exits }, ...OV, id: `${BASE_ID}${Object.keys(OV).length ? "*" : ""}` };
for (const [k, v] of Object.entries(OV)) if (k.startsWith("exit.")) P.exits[k.slice(5)] = v;
const S = { dwellTicks: 3, failTicks: 2, ttlSec: 900, cooldownSec: 1800, hystPct: 5, equityUsd: 100,
  riskPerTradePct: 20, qtyMax: 0.05, maxConcurrent: 2, nCandidatesMax: 8, sigmaConvention: "horizon",
  ...parseKV(argOf("--settings")) };
const EXEC = argOf("--exec", P.execModel === "taker-cross" ? "taker" : "mid");

// ── загрузка записи
const load = (kind) => {
  const out = [];
  for (const f of readdirSync(RECS).filter((x) => x.includes(`-${kind}-`) && x.endsWith(".ndjson")).sort()) {
    for (const line of readFileSync(join(RECS, f), "utf8").split("\n")) {
      if (line.trim()) { try { out.push(JSON.parse(line)); } catch {} }
    }
  }
  return out;
};
const ticks = load("ticks").sort((a, b) => a.ts - b.ts);
const snaps = new Map();
for (const r of load("surface")) {
  let m = snaps.get(r.ts);
  if (!m) { m = new Map(); snaps.set(r.ts, m); }
  m.set(r.n, r);
}
const times = [...snaps.keys()].sort((a, b) => a - b);
if (!ticks.length || times.length < 5) { console.error("запись пуста или неполна"); process.exit(1); }
const snapBefore = (ts) => { let lo = 0, hi = times.length - 1, res = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= ts) { res = m; lo = m + 1; } else hi = m - 1; } return res; };

// ── индекс снимка кэшируется: соседние тики почти всегда смотрят в один и тот же снимок
const snapIndex = new Map();
function indexOf(si) {
  let ix = snapIndex.get(si);
  if (ix) return ix;
  ix = indexSnapshot([...snaps.get(times[si]).values()]);
  if (snapIndex.size > 400) snapIndex.clear();
  snapIndex.set(si, ix);
  return ix;
}

const IDX = REPLAY_CONDITION_KEYS;
function evaluate(t) {
  const si = snapBefore(t.ts);
  if (si < 0) return null;
  return evaluateReplayTick({ tick: t, index: indexOf(si), preset: P, settings: S, depthMode: DEPTH_MODE });
}

// ── прогон по всем тикам с механикой жизненного цикла
const evals = [];
for (const t of ticks) { const e = evaluate(t); if (e) evals.push(e); }
if (!evals.length) { console.error("нечего оценивать"); process.exit(1); }

const signals = replaySignals(evals, S);

// ── отчёт
const q = (a, p) => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return null;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const f = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");
const spanH = (ticks.at(-1).ts - ticks[0].ts) / 3600000;

console.log(`# Проигрыш пресета по записи\n`);
console.log(`Пресет \`${P.id}\` (база \`${BASE_ID}\`)${Object.keys(OV).length ? `, правки: ${Object.entries(OV).map(([k, v]) => `${k}=${v}`).join(" · ")}` : ""}`);
console.log(`Запись: ${evals.length} тактов, ${f(spanH, 1)} ч. Окно экспираций ${P.expiryMinH}-${P.expiryMaxH} ч · отбор по ${P.strikeMode === "delta" ? `дельте ${P.deltaMin}-${P.deltaMax}` : `σ ${P.sigmaMin}-${P.sigmaMax}`}`);
console.log(`Механика: dwell ${S.dwellTicks} · кулдаун ${S.cooldownSec}с · кандидатов ≤${S.nCandidatesMax} · депозит $${S.equityUsd} · риск ${S.riskPerTradePct}%\n`);

console.log(`## Сигналы\n`);
console.log(`| величина | значение |`);
console.log(`|---|---|`);
console.log(`| тактов с вердиктом (все гейты pass) | ${evals.filter((e) => e.verdict).length} (${f((100 * evals.filter((e) => e.verdict).length) / evals.length, 1)}%) |`);
console.log(`| **сигналов после dwell и кулдауна** | **${signals.length}** |`);
console.log(`| разных инструментов | ${new Set(signals.map((s) => s.best.r.n)).size} |`);
console.log(`| лучший достигнутый вердикт | ${Math.max(...evals.map((e) => e.passed))}/${q(evals.map((e) => e.applicable), .5)} |`);

console.log(`\n## Условия: доля pass и что блокирует\n`);
console.log(`| условие | pass | fail | unknown | off | pass% | медиана значения | порог |`);
console.log(`|---|---|---|---|---|---|---|---|`);
const THR = { "У1": "> 0 п.п.", "У2": `≥ ${P.dIvPts} п.п.`, "У3": "> 0 п.п.", "У4": `≥ ${P.impulseMin}σ`,
  "У5": "совпадение", "У6": `≥ ${P.fivMinPts} п.п.`, "У7": `|skew| ≥ ${P.skewMinPts} (${P.skewMode})`,
  "У8": `≥ ${P.imbalanceMin}× (${P.imbalanceMode})`, "У9": P.strikeMode === "delta" ? `|Δ| ${P.deltaMin}-${P.deltaMax}` : `σ ${P.sigmaMin}-${P.sigmaMax}`,
  "У10": `≤ ${P.premMaxPct}% спота`, "У11": `≤ ${P.spreadMaxPctPrem}% премии`, "У12": `≥ $${P.depthMinUsd}`,
  "У13": `≤ ${P.thetaMaxPctDay}%/сут`, "У14": `≤ ${P.costMaxPctPrem}% премии` };
const blockers = [];
for (const k of IDX) {
  const c = { pass: 0, fail: 0, unknown: 0, off: 0 };
  for (const e of evals) c[e.st[k]] = (c[e.st[k]] ?? 0) + 1;
  const known = c.pass + c.fail;
  const pct = known ? (100 * c.pass) / known : null;
  const isGate = evals.some((e) => e.gateKeys.includes(k));
  if (isGate && pct != null && pct < 5) blockers.push({ k, pct, med: q(evals.map((e) => e.val[k]), .5) });
  console.log(`| ${k}${isGate ? "" : " (не гейт)"} | ${c.pass} | ${c.fail} | ${c.unknown} | ${c.off} | ${pct == null ? "н/д" : f(pct, 1) + "%"} | ${f(q(evals.map((e) => e.val[k]), .5), 2)} | ${THR[k]} |`);
}
if (blockers.length) {
  console.log(`\n**Блокируют (pass < 5%):** ${blockers.map((b) => `${b.k} (${f(b.pct, 1)}%, медиана ${f(b.med, 2)})`).join(" · ")}`);
} else if (!signals.length) {
  console.log(`\nОтдельного блокера нет: условия проходят порознь, но не одновременно.`);
}

console.log(`\n## Снабжение и цена набора\n`);
const noCand = evals.filter((e) => !e.nCand).length;
console.log(`| величина | значение |`);
console.log(`|---|---|`);
console.log(`| тактов без кандидатов | ${noCand} (${f((100 * noCand) / evals.length, 2)}%) |`);
console.log(`| кандидатов на такт | медиана ${q(evals.map((e) => e.nCand), .5)} · p90 ${q(evals.map((e) => e.nCand), .9)} · макс ${Math.max(...evals.map((e) => e.nCand))} |`);
console.log(`| экспираций в окне | медиана ${q(evals.map((e) => new Set([e.nearExp]).size), .5)} (near ${new Set(evals.map((e) => e.nearExp)).size} разных за запись) |`);
console.log(`| инструментов в наборе | медиана ${q(evals.map((e) => e.nInst), .5)} · макс ${Math.max(...evals.map((e) => e.nInst))} |`);
console.log(`| **GET/тик** (инстр + книг + 2, живая формула из лога) | медиана ${q(evals.map((e) => e.setSize), .5)} · макс ${Math.max(...evals.map((e) => e.setSize))} · ориентир §4.3 = 15 |`);
{
  const honest = evals.filter((e) => e.ivRefHonest != null);
  const ok = honest.filter((e) => e.ivRefHonest).length;
  const gaps = honest.filter((e) => !e.ivRefHonest).map((e) => Math.abs((e.best?.r.iv ?? NaN) - (e.ivRef ?? NaN)));
  console.log(`| **честность IV_ref** (экспирация лучшего == near окна) | ${f((100 * ok) / (honest.length || 1), 1)}%` +
    (gaps.length ? ` · на несовпадающих разрыв IV медиана ${f(q(gaps, .5), 2)} п.п., p90 ${f(q(gaps, .9), 2)}` : ``) + ` |`);
  const blocked = evals.filter((e) => e.sizeBlock).length;
  const unfit = evals.filter((e) => e.sizeFail);
  console.log(`| тактов, где лот не помещается в риск | ${unfit.length} (${f((100 * unfit.length) / evals.length, 1)}%)${unfit.length ? ` · ${[...new Set(unfit.map((e) => e.sizeFail))].join(", ")}` : ""} |`);
  console.log(`| из них СНЯЛИ бы готовый сигнал | ${blocked} |`);
}

const mc = evals.map((e) => e.best?.minCapitalUsd).filter(fin);
const over = mc.filter((x) => x > S.equityUsd).length;
console.log(`\n## Экономика лучшего кандидата\n`);
console.log(`| величина | медиана | p90 | макс |`);
console.log(`|---|---|---|---|`);
console.log(`| премия, % спота | ${f(q(evals.map((e) => e.best?.premPctSpot), .5), 2)} | ${f(q(evals.map((e) => e.best?.premPctSpot), .9), 2)} | ${f(Math.max(...evals.map((e) => e.best?.premPctSpot ?? -Infinity)), 2)} |`);
console.log(`| тета, %/сут | ${f(q(evals.map((e) => e.best?.thetaPctDay), .5), 2)} | ${f(q(evals.map((e) => e.best?.thetaPctDay), .9), 2)} | ${f(Math.max(...evals.map((e) => e.best?.thetaPctDay ?? -Infinity)), 2)} |`);
console.log(`| круг издержек, % премии | ${f(q(evals.map((e) => e.best?.rtcPct), .5), 2)} | ${f(q(evals.map((e) => e.best?.rtcPct), .9), 2)} | ${f(Math.max(...evals.map((e) => e.best?.rtcPct ?? -Infinity)), 2)} |`);
console.log(`| minCapital, $ | ${f(q(mc, .5), 0)} | ${f(q(mc, .9), 0)} | ${f(Math.max(...mc), 0)} |`);
console.log(`\n**Доля тактов, где minCapital выше депозита $${S.equityUsd}: ${f((100 * over) / (mc.length || 1), 1)}%.**` +
  (over / (mc.length || 1) > 0.5 ? ` Такой пресет не помещается в суб-счёт: минимальный лот ${REPLAY_LOT} BTC несёт риск выше ${S.riskPerTradePct}% депозита.` : ``));

// ── сделки
if (WANT_TRADES && signals.length) {
  const X = P.exits;
  const feeOf = (mark, index) => optionFeePct({ markUsd: mark, indexPrice: index }).feeUsd ?? 0;
  const buyPx = (r) => (EXEC === "mid" ? (fin(r.md) ? r.md : r.m) : fin(r.a) ? r.a : r.m);
  const sellPx = (r) => (EXEC === "mid" ? (fin(r.md) ? r.md : r.m) : fin(r.b) ? r.b : r.m);
  const trades = [];
  for (const s of signals) {
    const name = s.best.r.n;
    const i0 = snapBefore(s.ts);
    const r0 = snaps.get(times[i0])?.get(name);
    if (!r0 || !fin(r0.m)) continue;
    const entryPx = buyPx(r0), entryMark = r0.m;
    if (!posNum(entryPx)) continue;
    const paid = entryPx * REPLAY_LOT + feeOf(r0.m, s.spot) * REPLAY_LOT;
    let out = null;
    for (let j = i0 + 1; j < times.length; j++) {
      const r = snaps.get(times[j])?.get(name);
      if (!r || !fin(r.m)) continue;
      const heldH = (times[j] - times[i0]) / 3600000;
      const px = sellPx(r);
      const movePct = fin(r.f) ? ((r.f - s.spot) / s.spot) * 100 : null;
      const moveSigma = fin(movePct) && posNum(s.s1d) ? Math.abs(movePct) / s.s1d : null;
      let why = null;
      if (r.m >= entryMark * (1 + X.takeProfitPct / 100)) why = "тейк";
      else if (r.m <= entryMark * (1 - X.stopLossPctPrem / 100)) why = "стоп";
      else if (fin(r0.iv) && fin(r.iv) && r0.iv - r.iv >= X.ivDropExitPts) why = "падение воли";
      else if (heldH >= X.timeStopH && (!fin(moveSigma) || moveSigma < X.minMoveSigma)) why = "тайм-стоп";
      else if (fin(r.h) && r.h <= X.preExpiryCloseH) why = "преэкспирация";
      else if (j === times.length - 1) why = "конец записи";
      if (why) { const pnl = px * REPLAY_LOT - feeOf(r.m, r.f) * REPLAY_LOT - paid;
        out = { ts: s.ts, name, why, heldH, paid, pnl, retPct: (pnl / paid) * 100,
          days: (s.best.r.e - s.ts) / 86400000, delta: Math.abs(s.best.r.d ?? NaN) }; break; }
    }
    if (out) trades.push(out);
  }
  console.log(`\n## Сделки (исполнение ${EXEC === "mid" ? "по середине" : "тейкерское"}, размер ${REPLAY_LOT} BTC)\n`);
  if (!trades.length) console.log(`Сигналы есть, но ни одна сделка не закрылась внутри записи.`);
  else {
    const sum = trades.reduce((a, t) => a + t.pnl, 0), paid = trades.reduce((a, t) => a + t.paid, 0);
    console.log(`Сделок ${trades.length} · прибыльных ${f((100 * trades.filter((t) => t.pnl > 0).length) / trades.length, 0)}% · `
      + `медиана ${f(q(trades.map((t) => t.retPct), .5), 1)}% · итог на вложенное ${f((sum / paid) * 100, 1)}% · медиана удержания ${f(q(trades.map((t) => t.heldH), .5), 1)} ч\n`);
    if (!QUIET) {
      console.log(`| вход | инструмент | дельта | срок | держали | выход | результат |`);
      console.log(`|---|---|---|---|---|---|---|`);
      for (const t of trades.slice(0, TRADES_MAX)) {
        console.log(`| ${new Date(t.ts).toISOString().slice(5, 16).replace("T", " ")} | ${t.name.replace("BTC_USDC-", "")} | ${f(t.delta, 2)} | ${f(t.days, 1)}д | ${f(t.heldH, 1)} ч | ${t.why} | ${f(t.retPct, 1)}% |`);
      }
      if (trades.length > TRADES_MAX) console.log(`\n... и ещё ${trades.length - TRADES_MAX} строк (см. \`--trades-max\`).`);
    }
    console.log(`\n> Число сделок здесь НЕ равно числу независимых наблюдений: кулдаун и параллельные`);
    console.log(`> входы дают несколько строк на один эпизод рынка. Независимых в трёхсуточной записи`);
    console.log(`> порядка десяти (npm run eval:toll, раздел 3).`);
  }
}

console.log(`\n## Границы расчёта\n`);
console.log(`- Цены инструментов из снимка поверхности (каданс 300с), живой движок видел тикеры каждые 30с.`);
console.log(`- У12 (глубина): ${DEPTH_MODE === "assume" ? "стакана в записи нет, условие принято пройденным" : "без стакана уходит в unknown и блокирует вход"}. В прогоне 5 живая У12 давала 99.9% pass при медиане $40.7к против порога $5к.`);
console.log(`- IV_ref по каждой экспирации известен офлайн точно; живой сборщик знал его для near и подставлял DVOL остальным.`);
console.log(`- Подбор порогов до появления сделок на трёхсуточной записи есть подгонка. Этот отчёт отвечает «родится ли сигнал и во что войдём», а не «сколько заработаем».`);
