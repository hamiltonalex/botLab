#!/usr/bin/env node
// hist-build.mjs — восстановление записи сканера из кэша истории. READ-ONLY, без сети.
//
// ГЛАВНОЕ АРХИТЕКТУРНОЕ РЕШЕНИЕ: НА ВЫХОДЕ РОВНО ТОТ ЖЕ ФОРМАТ, что пишет живой процесс, —
// `scan-records/otm-scanner-{surface,ticks}-<сутки>.ndjson`. Не похожий, а тот же, ключ в ключ.
// Из этого следует всё остальное: `npm run eval:preset --dir <выход>`, `eval:toll`, `eval:buy`,
// `report:records` работают по истории БЕЗ ЕДИНОЙ ПРАВКИ, и бектест гоняет ту же самую механику
// отбора кандидатов, те же условия и тот же гейт размера, что поедут в бой.
//
// Это не стилистика. В проекте трижды случался один и тот же класс дефекта: две части системы
// решают формально одну задачу разными правилами, и расхождение молча искажает результат (книги
// доставались не тому кандидату; движок видел одну экспирацию из трёх; IV_ref брался из экспирации,
// которую пресет не покупает, на 100% тактов). Бектест со своей копией логики отбора стал бы
// четвёртым случаем и самым труднообнаружимым, потому что сверять его было бы не с чем. Здесь
// восстанавливается только СЫРЬЁ; ни одного правила движка тут нет.
//
// ЧТО ВОССТАНАВЛИВАЕТСЯ И ИЗ ЧЕГО:
//   поверхность  ← подгонка IV по ленте обратных опционов (hist-surface.js), цены и греки по
//                  Блэку-76 для ЛИНЕЙНЫХ инструментов, bid/ask по модели (hist-cost.js);
//   тики         ← часовые свечи перпа через computeRvBundle (rv.js) — те же RV7d/RV3d/σ1d/импульс/
//                  EMA, что считает живой процесс, плюс база DVOL за 90 суток.
//
// ЧЕСТНЫЕ ОТЛИЧИЯ ОТ ЖИВОЙ ЗАПИСИ, все три печатаются в сводке:
//   1. bid/ask МОДЕЛЬНЫЕ (истории котировок не существует). Это допущение, и оно помечено в
//      манифесте выхода полем `syntheticQuotes`.
//   2. Каданс часовой, а не 30-секундный: IV существует только в моменты сделок, и чаще часа
//      поверхность не обновляется осмысленно. Удержания в аудите 12-48 ч, разрешения хватает.
//   3. Глубина стакана отсутствует, поэтому строк `D` нет вовсе и У12 в историческом прогоне
//      обязано идти как `--depth assume` (eval-preset печатает долю таких тактов сам).
//
// ВЗГЛЯДА ВПЕРЁД НЕТ НИГДЕ. Окно сделок только назад (правило П1 в hist-surface.js); индекс берётся
// по последним сделкам НЕ ПОЗЖЕ метки; форвард — закрытие часового бара, ЗАКАНЧИВАЮЩЕГОСЯ на метке;
// RV и EMA считаются по закрытым барам (closedCandles). Каждое из этих мест уже однажды было
// возможностью подсмотреть будущее, поэтому названо поимённо.

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gunzipSync } from "node:zlib";
import { buildSurface, ivAt, tradeToPoint, parseOptionName, SURFACE_DEFAULTS } from "../src/engine/otmscan/hist-surface.js";
import { quotesFromMark, COST_MODEL_PROVENANCE } from "../src/engine/otmscan/hist-cost.js";
import { black76Greeks, yearsToExpiry } from "../src/engine/otmscan/black76.js";
import { computeRvBundle } from "../src/engine/otmscan/rv.js";
import { SCAN_DATA_RULES } from "../src/engine/otmscan/presets.js";

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const has = (n) => args.includes(n);

if (has("--help") || !argOf("--out")) {
  console.log(`hist-build.mjs — восстановление записи сканера из кэша истории

  --out <dir>        КУДА писать (обязательно); внутри создаётся scan-records/
  --cache <dir>      кэш истории (по умолчанию ~/botlab-hist-cache)
  --from <дата>      начало окна UTC (по умолчанию начало кэша)
  --to <дата>        конец окна UTC, не включая
  --tape inverse|both  какая лента кормит подгонку (по умолчанию inverse; см. шапку)
  --max-days <n>     потолок срока восстанавливаемых инструментов (по умолчанию 90)
  --max-logm <x>     потолок |ln(K/F)| (по умолчанию 0.6)
  --spread-scale <x> множитель модельного спреда (по умолчанию 1)
  --spread-mode ivPoints|pctPremium  шкала переноса спреда (по умолчанию ivPoints)
  --window-min <n>   окно подгонки назад, минут (по умолчанию 120)
  --half-life-min <n>  полураспад веса, минут (по умолчанию 30)
  --step-min <n>     шаг восстановления, минут (по умолчанию 60)`);
  process.exit(argOf("--out") ? 0 : 1);
}

const CACHE = argOf("--cache", join(homedir(), "botlab-hist-cache"));
const OUT = argOf("--out");
const TAPE = argOf("--tape", "inverse");
const MAX_DAYS = Number(argOf("--max-days", "90"));
const MAX_LOGM = Number(argOf("--max-logm", "0.6"));
const SPREAD_SCALE = Number(argOf("--spread-scale", "1"));
const SPREAD_MODE = argOf("--spread-mode", "ivPoints");
const STEP_MS = Number(argOf("--step-min", "60")) * 60000;
const FIT_OPTS = {
  ...SURFACE_DEFAULTS,
  shapeMode: argOf("--shape", SURFACE_DEFAULTS.shapeMode),
  windowMs: Number(argOf("--window-min", String(SURFACE_DEFAULTS.windowMs / 60000))) * 60000,
  halfLifeMs: Number(argOf("--half-life-min", String(SURFACE_DEFAULTS.halfLifeMs / 60000))) * 60000,
  minPoints: Number(argOf("--min-points", String(SURFACE_DEFAULTS.minPoints))),
  xMarginFrac: Number(argOf("--x-margin", String(SURFACE_DEFAULTS.xMarginFrac))),
};

const cachePath = (...p) => join(CACHE, ...p);
const readJson = (rel) => JSON.parse(readFileSync(cachePath(rel), "utf8"));
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

// ── мета: истёкшие + живые, одна карта на семейство
function loadMeta(kind) {
  const out = new Map();
  for (const half of ["expired", "active"]) {
    const rel = `meta/${kind}-${half}.json`;
    if (!existsSync(cachePath(rel))) continue;
    for (const m of readJson(rel)) if (m?.instrument_name) out.set(m.instrument_name, m);
  }
  return out;
}

const optMeta = [...loadMeta("usdc-option").values()]
  .filter((m) => m.instrument_name.startsWith("BTC_USDC-") && fin(m.expiration_timestamp) && posNum(m.strike))
  .sort((a, b) => a.expiration_timestamp - b.expiration_timestamp || a.strike - b.strike);
if (!optMeta.length) { console.error(`в кэше ${CACHE} нет меты линейных опционов — сначала npm run hist:download`); process.exit(1); }

// ── свечи: перп (прокси индекса и вход RV) + фьючерсы (форвард экспираций)
// Файл ряда несёт своё покрытие (fromMs/toMs) — см. грабли резюмируемости в hist-download.mjs.
const barsOf = (rel) => (existsSync(cachePath(rel)) ? readJson(rel)?.bars ?? [] : []);
const perp = barsOf("candles/BTC-PERPETUAL.json");
if (!perp.length) { console.error("нет свечей перпа в кэше — сначала npm run hist:download"); process.exit(1); }
const perpByBarEnd = new Map(perp.map((c) => [c.ts + HOUR_MS, c.close]));

// Форвард по фьючерсам: закрытие бара, ЗАКАНЧИВАЮЩЕГОСЯ на метке (взгляда вперёд нет).
const futSeries = new Map(); // expiryMs -> Map<barEndMs, close>
for (const f of loadMeta("btc-future").values()) {
  if (f.settlement_period === "perpetual" || !f.instrument_name?.startsWith("BTC-")) continue;
  const m = new Map();
  for (const c of barsOf(`candles/${f.instrument_name}.json`)) if (posNum(c.close)) m.set(c.ts + HOUR_MS, c.close);
  if (m.size) futSeries.set(f.expiration_timestamp, m);
}

// ── DVOL: часовой ряд → дневные закрытия → скользящая база за 90 суток (правило SCAN_DATA_RULES)
const dvol = existsSync(cachePath("dvol/btc-hourly.json")) ? readJson("dvol/btc-hourly.json") : [];
const dvolDailyClose = new Map();
for (const d of dvol) if (posNum(d.close)) dvolDailyClose.set(Math.floor(d.ts / DAY_MS), d.close);
const dvolHour = new Map(dvol.filter((d) => posNum(d.close)).map((d) => [Math.floor(d.ts / HOUR_MS) * HOUR_MS, d.close]));
function baselineIvAt(ts) {
  const d0 = Math.floor(ts / DAY_MS);
  const vals = [];
  for (let d = d0 - SCAN_DATA_RULES.dvolBaselineDays; d < d0; d++) {
    const v = dvolDailyClose.get(d);
    if (posNum(v)) vals.push(v);
  }
  // Меньше половины окна — не база, а выдумка: правило tri-state сильнее желания получить число.
  return vals.length >= SCAN_DATA_RULES.dvolBaselineDays / 2
    ? vals.reduce((s, x) => s + x, 0) / vals.length : null;
}

// ── лента: суточные gz-файлы кэша, читаются по мере надобности и выбрасываются
const tapeCache = new Map();
function tradesOfDay(cur, dayMs) {
  const key = `${cur}|${dayMs}`;
  if (tapeCache.has(key)) return tapeCache.get(key);
  const rel = `trades/${cur.toLowerCase()}-option-${dayKey(dayMs)}.ndjson.gz`;
  let rows = [];
  if (existsSync(cachePath(rel))) {
    const txt = gunzipSync(readFileSync(cachePath(rel))).toString("utf8");
    for (const line of txt.split("\n")) if (line.trim()) { try { rows.push(JSON.parse(line)); } catch {} }
  }
  if (tapeCache.size > 6) tapeCache.delete(tapeCache.keys().next().value);
  tapeCache.set(key, rows);
  return rows;
}
// Сделки за окно [from, to]: окно может пересекать границу суток, поэтому читаются оба файла.
function tradesInWindow(fromMs, toMs) {
  const curs = TAPE === "both" ? ["BTC", "USDC"] : ["BTC"];
  const out = [];
  for (const cur of curs) {
    for (let d = Math.floor(fromMs / DAY_MS) * DAY_MS; d <= toMs; d += DAY_MS) {
      for (const t of tradesOfDay(cur, d)) {
        if (t.timestamp >= fromMs && t.timestamp <= toMs) out.push(t);
      }
    }
  }
  return out;
}

// ── окно восстановления
const cacheDays = existsSync(cachePath("trades"))
  ? readdirSync(cachePath("trades")).filter((f) => f.startsWith("btc-option-")).map((f) => Date.parse(`${f.slice(11, 21)}T00:00:00Z`)).sort((a, b) => a - b)
  : [];
if (!cacheDays.length) { console.error("в кэше нет ленты сделок"); process.exit(1); }
const FROM = argOf("--from") ? Date.parse(`${argOf("--from")}T00:00:00Z`) : cacheDays[0] + DAY_MS;
const TO = argOf("--to") ? Date.parse(`${argOf("--to")}T00:00:00Z`) : cacheDays.at(-1) + DAY_MS;

// ── индекс на метке: последние сделки НЕ ПОЗЖЕ t (index_price приходит в каждой строке ленты).
// Перп берётся фолбэком: он торгуется с базисом к индексу, поэтому это второй выбор, а не первый.
function indexAt(ts, windowTrades) {
  const near = [];
  for (const t of windowTrades) {
    if (t.timestamp <= ts && ts - t.timestamp <= 10 * 60000 && posNum(t.index_price)) near.push(t.index_price);
  }
  if (near.length) { near.sort((a, b) => a - b); return near[Math.floor(near.length / 2)]; }
  return perpByBarEnd.get(ts) ?? null;
}

// ── форвард экспирации: свой фьючерс, иначе интерполяция ставки базиса по сроку
// Базис ведёт себя как непрерывная ставка: замер по записи прогона 5 даёт +0.020% на 0.83 суток и
// +0.624% на 50.83 — то есть ln(F/S)/T почти постоянен. Поэтому интерполируется именно СТАВКА,
// а не сам форвард: так короткие и длинные экспирации не растаскивают кривую.
function forwardFactory(ts, spot) {
  const rates = []; // { T, rate } где rate = ln(F/S)/T
  for (const [exp, series] of futSeries) {
    if (exp <= ts) continue;
    const close = series.get(ts);
    if (!posNum(close) || !posNum(spot)) continue;
    const T = (exp - ts) / (365 * DAY_MS);
    if (!(T > 0)) continue;
    rates.push({ T, rate: Math.log(close / spot) / T });
  }
  rates.sort((a, b) => a.T - b.T);
  const cache = new Map();
  return (expiryMs) => {
    if (cache.has(expiryMs)) return cache.get(expiryMs);
    let F = null;
    const own = futSeries.get(expiryMs)?.get(ts);
    if (posNum(own)) F = own;
    else if (rates.length && posNum(spot)) {
      const T = (expiryMs - ts) / (365 * DAY_MS);
      if (T > 0) {
        let r;
        if (T <= rates[0].T) r = rates[0].rate;
        else if (T >= rates.at(-1).T) r = rates.at(-1).rate;
        else {
          let i = 0;
          while (i < rates.length - 1 && rates[i + 1].T < T) i++;
          const a = rates[i], b = rates[i + 1];
          r = a.rate + ((b.rate - a.rate) * (T - a.T)) / (b.T - a.T);
        }
        F = spot * Math.exp(r * T);
      }
    }
    cache.set(expiryMs, F);
    return F;
  };
}

// ── прогон
mkdirSync(join(OUT, "scan-records"), { recursive: true });
const stats = {
  ticks: 0, ticksSkipped: 0, surfaceRows: 0, snapshots: 0,
  noIv: 0, noForward: 0, noQuote: 0, instrumentsSeen: 0,
  expiriesFitted: 0, tradesUsed: 0, tickNoSide: 0, tickNoRv: 0,
};
const filesOpen = new Map();
const appendRow = (kind, ts, row) => {
  const key = `${kind}|${dayKey(ts)}`;
  let buf = filesOpen.get(key);
  if (!buf) { buf = []; filesOpen.set(key, buf); }
  buf.push(JSON.stringify(row));
};
const flushDay = (dk) => {
  for (const kind of ["surface", "ticks"]) {
    const key = `${kind}|${dk}`;
    const buf = filesOpen.get(key);
    if (!buf?.length) continue;
    writeFileSync(join(OUT, "scan-records", `otm-scanner-${kind}-${dk}.ndjson`), buf.join("\n") + "\n");
    filesOpen.delete(key);
  }
};

const r = (x, n) => (fin(x) ? Number(x.toFixed(n)) : null);
const t0 = Date.now();
let curDay = null;

console.log(`# Восстановление записи из истории`);
console.log(`Окно ${dayKey(FROM)} .. ${dayKey(TO)} · шаг ${STEP_MS / 60000} мин · лента ${TAPE}`);
console.log(`Подгонка: окно назад ${FIT_OPTS.windowMs / 60000} мин, полураспад ${FIT_OPTS.halfLifeMs / 60000} мин`);
console.log(`Спред: МОДЕЛЬ ${SPREAD_MODE} × ${SPREAD_SCALE} (${COST_MODEL_PROVENANCE.source})`);
console.log(`Потолки восстановления: срок ≤ ${MAX_DAYS} сут, |ln(K/F)| ≤ ${MAX_LOGM}\n`);

for (let ts = Math.ceil(FROM / STEP_MS) * STEP_MS; ts < TO; ts += STEP_MS) {
  const dk = dayKey(ts);
  if (dk !== curDay) { if (curDay) flushDay(curDay); curDay = dk; }

  const winFrom = ts - FIT_OPTS.windowMs;
  const win = tradesInWindow(winFrom, ts);
  const spot = indexAt(ts, win);
  if (!posNum(spot)) { stats.ticksSkipped += 1; continue; }

  const fwdOf = forwardFactory(ts, spot);
  const points = [];
  for (const t of win) {
    const p = tradeToPoint(t, (expiryMs) => fwdOf(expiryMs));
    if (p) points.push(p);
  }
  const surf = buildSurface({ trades: points, nowMs: ts, opts: FIT_OPTS });
  stats.tradesUsed += surf.stats.pointsUsed;
  stats.expiriesFitted += surf.stats.expiriesFitted;
  if (!surf.smiles.size) { stats.ticksSkipped += 1; continue; }

  // ── строки поверхности по ЛИНЕЙНЫМ инструментам, листингованным на эту метку
  let emitted = 0;
  for (const m of optMeta) {
    if (!(m.creation_timestamp <= ts && m.expiration_timestamp > ts)) continue;
    const days = (m.expiration_timestamp - ts) / DAY_MS;
    if (days > MAX_DAYS) continue;
    stats.instrumentsSeen += 1;
    const F = fwdOf(m.expiration_timestamp);
    if (!posNum(F)) { stats.noForward += 1; continue; }
    if (Math.abs(Math.log(m.strike / F)) > MAX_LOGM) continue;
    const iv = ivAt(surf, { expiryMs: m.expiration_timestamp, strikeUsd: m.strike, forwardUsd: F, nowMs: ts, forwardOf: fwdOf, opts: FIT_OPTS });
    if (!posNum(iv)) { stats.noIv += 1; continue; }
    const tY = yearsToExpiry(ts, m.expiration_timestamp);
    const g = black76Greeks({ forwardUsd: F, strikeUsd: m.strike, ivPct: iv, tYears: tY, optionType: m.option_type });
    if (!posNum(g.priceUsd)) { stats.noQuote += 1; continue; }
    const q = quotesFromMark({ deltaAbs: Math.abs(g.delta), daysToExpiry: days, markUsd: g.priceUsd, vegaUsd: g.vegaUsd, invariant: SPREAD_MODE, scale: SPREAD_SCALE });
    if (!q) { stats.noQuote += 1; continue; }
    // Ключи и округления — ровно как в surface.js живого рекордера.
    appendRow("surface", ts, {
      ts, n: m.instrument_name, e: m.expiration_timestamp, k: m.strike,
      s: m.option_type === "call" ? "C" : "P",
      h: r(tY * 365 * 24, 3), f: r(F, 2),
      b: r(q.bid, 2), a: r(q.ask, 2), m: r(g.priceUsd, 2), md: r(q.mid, 2),
      iv: r(iv, 2), oi: null, vu: null,
      d: r(g.delta, 4), th: r(g.thetaUsd, 3), vg: r(g.vegaUsd, 3),
    });
    emitted += 1;
  }
  if (!emitted) { stats.ticksSkipped += 1; continue; }
  stats.surfaceRows += emitted;
  stats.snapshots += 1;

  // ── строка тика: уровень актива теми же функциями, что у живого процесса
  const bundle = computeRvBundle(perp, ts, { emaPeriod: 20 });
  if (!posNum(bundle.rv7dPct)) stats.tickNoRv += 1;
  if (!bundle.direction) stats.tickNoSide += 1;
  const base = baselineIvAt(ts);
  appendRow("ticks", ts, {
    ts, pid: null, sd: bundle.direction, S: r(spot, 2),
    vd: null, ps: null, ap: null, uk: null, ck: null, ph: null,
    dg: false, bo: false, cn: null, sk: 0,
    rv7: r(bundle.rv7dPct, 3), rv3: r(bundle.rv3dPct, 3), s1d: r(bundle.sigma1dPct, 3),
    imp: r(bundle.impulse, 3), dir: bundle.direction,
    // IV_ref намеренно НЕ восстанавливается здесь: eval-preset выводит его сам из ATM-пары
    // ближней экспирации окна пресета, и подсовывать своё значение значило бы завести второе
    // правило для одной задачи — ровно тот дефект, ради избежания которого всё и строится.
    ivr: null, ivs: "hist-surface", base: r(base, 3),
    V: { "У5": fin(bundle.lastClose) && posNum(bundle.ema) ? r((bundle.lastClose / bundle.ema - 1) * 100, 4) : null },
    St: "",
  });
  stats.ticks += 1;

  if (stats.ticks % 500 === 0) {
    console.log(`  ${new Date(ts).toISOString().slice(0, 13)}Z · тиков ${stats.ticks} · строк ${stats.surfaceRows} · ${((Date.now() - t0) / 1000).toFixed(0)}с`);
  }
}
if (curDay) flushDay(curDay);

const manifest = {
  builtAt: new Date().toISOString(),
  from: dayKey(FROM), to: dayKey(TO), stepMin: STEP_MS / 60000, tape: TAPE,
  fit: { windowMin: FIT_OPTS.windowMs / 60000, halfLifeMin: FIT_OPTS.halfLifeMs / 60000, minPoints: FIT_OPTS.minPoints, xMarginFrac: FIT_OPTS.xMarginFrac },
  caps: { maxDays: MAX_DAYS, maxLogMoneyness: MAX_LOGM },
  syntheticQuotes: { isAssumption: true, mode: SPREAD_MODE, scale: SPREAD_SCALE, provenance: COST_MODEL_PROVENANCE },
  noDepth: "стакана в истории нет: строк D нет, У12 требует --depth assume",
  stats,
};
writeFileSync(join(OUT, "hist-manifest.json"), JSON.stringify(manifest, null, 2));

const pct = (a, b) => (b > 0 ? ((100 * a) / b).toFixed(1) : "н/д");
console.log(`\n## Итог`);
console.log(`| величина | значение |`);
console.log(`|---|---|`);
console.log(`| снимков поверхности | ${stats.snapshots} |`);
console.log(`| строк поверхности | ${stats.surfaceRows} |`);
console.log(`| строк тиков | ${stats.ticks} |`);
console.log(`| меток пропущено (нет спота/смайла/строк) | ${stats.ticksSkipped} |`);
console.log(`| инструментов рассмотрено | ${stats.instrumentsSeen} |`);
console.log(`| из них без IV (правила П3/П4) | ${stats.noIv} (${pct(stats.noIv, stats.instrumentsSeen)}%) |`);
console.log(`| из них без форварда | ${stats.noForward} (${pct(stats.noForward, stats.instrumentsSeen)}%) |`);
console.log(`| из них без котировки | ${stats.noQuote} (${pct(stats.noQuote, stats.instrumentsSeen)}%) |`);
console.log(`| тиков без стороны (импульс н/д) | ${stats.tickNoSide} |`);
console.log(`| тиков без RV7d | ${stats.tickNoRv} |`);
console.log(`| экспираций подогнано на снимок | ${stats.snapshots ? (stats.expiriesFitted / stats.snapshots).toFixed(1) : "н/д"} |`);
console.log(`| точек ленты на снимок | ${stats.snapshots ? (stats.tradesUsed / stats.snapshots).toFixed(0) : "н/д"} |`);
console.log(`\nГотово за ${((Date.now() - t0) / 1000).toFixed(0)}с. Выход: ${OUT}`);
console.log(`\n> bid/ask в этой записи МОДЕЛЬНЫЕ (${SPREAD_MODE} × ${SPREAD_SCALE}). Историю котировок Deribit не хранит.`);
