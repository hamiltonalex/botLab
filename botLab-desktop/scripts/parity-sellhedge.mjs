#!/usr/bin/env node
// parity-sellhedge.mjs - ПАРНАЯ СВЕРКА: решения эталона против решений живого движка на ОДНИХ И
// ТЕХ ЖЕ данных. READ-ONLY.
//
// ЗАЧЕМ. Прибыльная схема (продажа колла с дельта-хеджем) живёт в `src/engine/otmscan/sellhedge.js`,
// а живой бот 2 хеджится своим движком `src/engine/btcopt/hedge.js`, написанным под четырёхногий
// стрэддл. Пока эти два правила не сверены НА СНИМКАХ, «перенос в бой» означает надежду, а не
// перенос: любое расхождение правил меняет и число перекладок, и итог.
//
// ЧТО СЧИТАЕТСЯ. Цепочка сделок строится ОДИН раз правилами эталона (какой контракт продать, когда
// закрыть). Внутри каждой сделки путь наблюдений материализуется и по нему прогоняются варианты
// хеджа, отличающиеся ровно одним правилом каждый. Так расхождение получает АДРЕС, а не общий счёт.
//
// ВАРИАНТЫ, и каждый следующий добавляет ровно одно правило движка:
//   эталон           - полоса 0.03 BTC на контракт, больше ничего;
//   движок-полоса    - тот же decideHedge, полоса 0.03, λ и триггеры выключены. ОБЯЗАН совпасть с
//                      эталоном решение в решение: это проверка того, что механика движка не несёт
//                      собственного смещения;
//   +λ и триггер цены - гейт benefit > cost × 1.25 (у эталона его нет вовсе). ОДНОЙ СТРОКОЙ, И ЭТО
//                      НЕ ЛЕНЬ: `cfg.priceTriggerPct` в движке служит СРАЗУ двумя вещами - порогом
//                      ценового триггера и масштабом `m` в expectedBenefit. Выключить триггер,
//                      сохранив масштаб выгоды, нечем, поэтому и мерить их порознь нельзя;
//   +триггер времени - плюс rehedgeSec 60с;
//   +блэкаут         - плюс пауза 08:00 UTC ±10 мин и 30 мин преэкспирации;
//   полоса бота 2    - всё вышеперечисленное и полоса 0.001 BTC, приведённая к контракту (÷ qty
//                      0.01 = 0.1 BTC на контракт): дефолт бота 2 задан АБСОЛЮТНЫМ числом и с
//                      размером позиции не масштабируется;
//   дельта по споту  - хедж по ∂V/∂S вместо ∂V/∂F (дельта записи считается от ФОРВАРДА, а перп
//                      торгуется от спота; отношение F/S = e^(rT) берётся из строки записи);
//   дельта движка    - Qperp меряется как qty·cs/mark ПО ТЕКУЩЕЙ цене (markPerp в pnl.js), то есть
//                      уплывает как 1/P между перекладками.
//
// ЧЕГО СВЕРКА НЕ ЛОВИТ, названо явно: глубины перпа в записи нет, поэтому проскальзывание сверх
// комиссии не моделируется ни у одной стороны, и «дорогое исполнение» здесь это только комиссия.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gunzipSync } from "node:zlib";
import { priceAt, makePriceStats, countPrice, formatPriceStats } from "../src/engine/otmscan/hist-price.js";
import { computeTradeCosts } from "../src/engine/otmscan/economics.js";
import { legMargin } from "../src/engine/btcopt/margin.js";
import { decideHedge, applyFill } from "../src/engine/btcopt/hedge.js";
import {
  SELLHEDGE_DEFAULTS, pickSellLeg, openSellTrade, halfSpreadUsd, walkSellTrade, settleSellTrade,
} from "../src/engine/otmscan/sellhedge.js";

const fin = (x) => Number.isFinite(x);
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const has = (n) => args.includes(n);

if (has("--help") || !argOf("--dir")) {
  console.log(`parity-sellhedge.mjs - парная сверка решений эталона и движка

  --dir <каталог>     запись восстановления (обязательно)
  --funding <файл>    почасовой фандинг перпа (по умолчанию из кэша hist-download)
  --chain-adj <x>     множитель итога сделки (0.69 приводит обратную цепочку к линейной)
  --band <x>          полоса эталона, BTC на контракт (по умолчанию 0.03)
  --perp-fee <x>      комиссия перпа долей (0 мейкер, 0.0005 тейкер; по умолчанию 0)
  --trades            печатать расхождения по сделкам`);
  process.exit(argOf("--dir") ? 0 : 1);
}

const DIR = argOf("--dir");
const CHAIN_ADJ = Number(argOf("--chain-adj", "1"));
const BAND = Number(argOf("--band", "0.03"));
const PERP_FEE = Number(argOf("--perp-fee", "0"));
const CS = 10; // размер обратного контракта BTC-PERPETUAL, USD
const LOT = 0.01; // минимальный лот опциона: к нему приводится абсолютная полоса бота 2

// ── запись (тот же формат, что пишет живой рекордер)
function load(dir) {
  const D = readdirSync(dir).some((f) => f === "scan-records") ? join(dir, "scan-records") : dir;
  const snaps = new Map(); const ticks = [];
  for (const f of readdirSync(D).sort()) {
    const kind = f.includes("-ticks-") ? "t" : f.includes("-surface-") ? "s" : null;
    if (!kind) continue;
    for (const line of readFileSync(join(D, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (kind === "t") ticks.push(r);
      else { let m = snaps.get(r.ts); if (!m) { m = new Map(); snaps.set(r.ts, m); } m.set(r.n, r); }
    }
  }
  ticks.sort((a, b) => a.ts - b.ts);
  const times = [...snaps.keys()].sort((a, b) => a - b);
  const tts = ticks.map((t) => t.ts);
  const spot = times.map((t) => {
    let lo = 0, hi = tts.length - 1, res = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (tts[m] <= t) { res = m; lo = m + 1; } else hi = m - 1; }
    return res == null ? null : ticks[res].S ?? null;
  });
  const byExp = new Map();
  for (const [ts, m] of snaps) {
    const e = new Map();
    for (const r of m.values()) { let a = e.get(r.e); if (!a) { a = []; e.set(r.e, a); } a.push(r); }
    byExp.set(ts, e);
  }
  return { snaps, times, spot, byExp, stats: makePriceStats() };
}
const R = load(DIR);
const N = R.times.length;
if (!N) { console.error(`пусто: ${DIR}`); process.exit(1); }

const FUND = new Map();
{
  const rel = argOf("--funding") ?? join(homedir(), "botlab-hist-cache", "funding", "btc-perpetual-1h.json");
  for (const p of [rel, `${rel}.gz`]) {
    try {
      const buf = readFileSync(p);
      for (const f of JSON.parse((p.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8")))
        if (fin(f?.ts) && fin(f?.r1h)) FUND.set(Math.floor(f.ts / 3600000) * 3600000, f.r1h);
      break;
    } catch { /* следующий вариант пути */ }
  }
}
const fundRate = (ts) => FUND.get(Math.floor(ts / 3600000) * 3600000) ?? 0;

const mean = (a) => { const s = a.filter(fin); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : NaN; };
const q = (a, p) => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return NaN;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const f2 = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");
const dt = (ms) => new Date(ms).toISOString().slice(0, 10);
const spotBefore = (T) => { let lo = 0, hi = N - 1, res = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (R.times[m] <= T) { res = R.spot[m]; lo = m + 1; } else hi = m - 1; } return res; };

const CFG = { ...SELLHEDGE_DEFAULTS, bandBtc: BAND, perpFee: PERP_FEE, chainAdj: CHAIN_ADJ, execModel: "maker-mid" };

// ── ВАРИАНТЫ ХЕДЖА. Каждый отличается от предыдущего ровно одним правилом; `ref: true` помечает
// эталонную реализацию (полоса и ничего больше).
const OFF_TRIGGER = 1e9; // «никогда»: 1e9% движения и 1e9 секунд не наступают на этих данных
const engineCfg = (over) => ({
  deadbandBtc: BAND, priceTriggerPct: OFF_TRIGGER, rehedgeSec: OFF_TRIGGER, lambda: 0,
  execStyle: "limit", makerFeeRate: 0, takerFeeRate: 0.0005, slippageRate: 0.0002,
  fundingHorizonSec: 28800, dailyWindowSec: 600, preExpirySec: 1800, settlementBlackout: false,
  ...over,
});
const VARIANTS = [
  { key: "ref", label: "эталон (только полоса)", ref: true },
  { key: "eng", label: "движок, полоса 0.03", cfg: engineCfg({}) },
  { key: "lam", label: "+ λ 1.25 и триггер цены 0.5% (один knob)", cfg: engineCfg({ lambda: 1.25, priceTriggerPct: 0.5 }) },
  { key: "trg", label: "+ триггер времени 60с", cfg: engineCfg({ lambda: 1.25, priceTriggerPct: 0.5, rehedgeSec: 60 }) },
  { key: "blk", label: "+ блэкаут расчёта", cfg: engineCfg({ lambda: 1.25, priceTriggerPct: 0.5, rehedgeSec: 60, settlementBlackout: true }) },
  { key: "b2", label: "полоса бота 2 (0.001 ÷ лот = 0.1)", cfg: engineCfg({ lambda: 1.25, priceTriggerPct: 0.5, rehedgeSec: 60, settlementBlackout: true, deadbandBtc: 0.001 / LOT }) },
  { key: "fwd", label: "дельта по СПОТУ (× F/S)", cfg: engineCfg({}), spotDelta: true },
  { key: "drift", label: "дельта движка (qty·cs/mark)", cfg: engineCfg({}), driftDelta: true },
  // КАДАНС ПРОВЕРКИ отдельно от учёта: P&L и фандинг копятся на КАЖДОМ снимке, а решение
  // спрашивается раз в N снимков. Только так видно, решает полоса или частота. Замер по живой
  // записи (48 часов) говорил, что не решает; здесь тот же вопрос задаётся пяти годам.
  { key: "c4", label: "каданс решения 4ч", cfg: engineCfg({}), stride: 4 },
  { key: "c12", label: "каданс решения 12ч", cfg: engineCfg({}), stride: 12 },
  { key: "c24", label: "каданс решения 24ч", cfg: engineCfg({}), stride: 24 },
];

// Прогон одного варианта по материализованному пути наблюдений сделки.
//   path[k] = { ts, S, delta, fs } - метка, спот, дельта опциона (по форварду), отношение F/S.
// Возвращает { hedgePnl, hedgeFee, funding, rehedges, decisions } - decisions это строка решений
// («h» переложились, «.» нет) для посимвольной сверки с эталоном.
//
// УЧЁТ P&L ОДИН НА ВСЕ ВАРИАНТЫ, И ЭТО НЕ УПРОЩЕНИЕ. Долларовый P&L обратного перпа ЛИНЕЕН по
// цене: позиция N контрактов по $cs со средним входом A даёт U = N·cs·(P − A)/A, то есть
// dU/dP = N·cs/A и от текущей цены не зависит. Значит `q·ΔS` эталона это точная формула, а не
// приближение, и различаются варианты ИЗМЕРЕНИЕМ дельты, а не её учётом.
function runHedge(v, path, entryTs, entryS, entryWant, expiryMs) {
  const wantOf = (p) => (v.spotDelta ? p.delta * p.fs : p.delta);
  // Вариант drift ведёт НАСТОЯЩЕЕ состояние обратной позиции через applyFill движка: только так
  // видно, что markPerp меряет дельту как qty·cs/mark ПО ТЕКУЩЕЙ цене, а долларовая дельта равна
  // qty·cs/avgEntry. Между перекладками эти два числа расходятся как 1/P.
  // Долларовая дельта обратной позиции = qty·cs/avgEntry. ПЛОСКАЯ позиция даёт 0/0, и applyFill
  // обнуляет avgEntry ровно тогда, когда qty приходит в ноль, поэтому ноль проверяется явно:
  // без этого NaN уполз бы в P&L и в отчёте вылез бы «н/д» вместо расхождения.
  const usdDeltaOf = (s) => (s.qty !== 0 && s.avgEntry > 0 ? (s.qty * CS) / s.avgEntry : 0);
  const perp = { qty: 0, avgEntry: 0, realizedUsd: 0, feesCum: 0 };
  const feeCfg = { makerFeeRate: 0, takerFeeRate: 0.0005 };
  const fill = (btc, priceRef) => applyFill(perp,
    { side: btc > 0 ? "buy" : "sell", amount_rounded_btc: Math.abs(btc), order_type: "limit" },
    priceRef, { contractSize: CS }, feeCfg);
  // qPerp - ФАКТИЧЕСКАЯ долларовая дельта позиции (BTC на единицу спота).
  let qPerp = entryWant;
  if (v.driftDelta) { fill(entryWant, entryS); qPerp = usdDeltaOf(perp); }
  let hedgePnl = 0, funding = 0, rehedges = 1, decisions = "";
  let hedgeFee = Math.abs(entryWant) * entryS * PERP_FEE;
  let prevS = entryS, prevTs = entryTs, lastHedgeAt = entryTs, lastHedgeUnderlying = entryS;
  let idx = -1;
  for (const p of path) {
    idx += 1;
    hedgePnl += qPerp * (p.S - prevS);
    funding += qPerp * p.S * fundRate(p.ts) * ((p.ts - prevTs) / 3600000);
    prevS = p.S; prevTs = p.ts;
    if (p.ts >= expiryMs) break;
    // Каданс режет только СПРАШИВАНИЕ решения: учёт выше идёт на каждом снимке.
    if (v.stride && idx % v.stride !== 0) { decisions += "."; continue; }
    const want = wantOf(p);
    // Дельта, КОТОРУЮ ВИДИТ движок (markPerp, pnl.js:51), против фактической долларовой.
    const seen = v.driftDelta && perp.qty !== 0 ? (perp.qty * CS) / p.S : qPerp;
    let fire;
    if (v.ref) {
      fire = Math.abs(want - seen) > BAND;
    } else {
      const d = decideHedge({
        optionDelta: -want, Qperp: seen,
        snapshot: { underlying: p.S, perp: { mark: p.S, funding8h: fundRate(p.ts) * 8 } },
        liquidity: { halfSpread: 0 }, cfg: v.cfg, nowMs: p.ts, expiryMs,
        createdAt: entryTs, lastHedgeAt, lastHedgeUnderlying, step: 0,
      });
      fire = d.decision === "HEDGE";
    }
    decisions += fire ? "h" : ".";
    if (fire) {
      const order = want - seen; // движок торгует НЕВЯЗКУ к тому, что он видит
      hedgeFee += Math.abs(order) * p.S * PERP_FEE;
      if (v.driftDelta) { fill(order, p.S); qPerp = usdDeltaOf(perp); }
      else qPerp += order;
      rehedges += 1;
      lastHedgeAt = p.ts; lastHedgeUnderlying = p.S;
    }
  }
  hedgeFee += Math.abs(qPerp) * prevS * PERP_FEE;
  return { hedgePnl, hedgeFee, funding, rehedges, decisions };
}

// ── цепочка эталона с материализацией пути
const trades = [];
{
  let i = 0;
  while (i < N - 1) {
    const snap = R.snaps.get(R.times[i]); const S0 = R.spot[i];
    const leg = snap && S0 > 0 ? pickSellLeg(snap.values(), CFG) : null;
    if (!leg) { i += 1; continue; }
    const half = halfSpreadUsd(leg, CFG);
    const costs = computeTradeCosts({ markUsd: leg.m, bidUsd: leg.m - half, askUsd: leg.m + half,
      indexPrice: S0, execModel: CFG.execModel });
    const im = costs ? legMargin({ type: "call", side: "short", strike: leg.k, mark: leg.m,
      underlying: S0, index: S0, amount: 1 }).im : null;
    const open = costs ? openSellTrade({ leg, spotUsd: S0, costs, imUsd: im, cfg: CFG }) : null;
    if (!open) { i += 1; continue; }
    const meta = { name: leg.n, expiryMs: leg.e, strikeUsd: leg.k, type: "C" };
    const base = i + 1;
    const path = [];
    const walk = walkSellTrade({
      count: N - base,
      tsAt: (k) => R.times[base + k],
      spotAt: (k) => R.spot[base + k],
      priceAt: (k) => {
        const ts = R.times[base + k];
        const p = countPrice(R.stats, priceAt({ snapshot: R.snaps.get(ts),
          expiryRows: R.byExp.get(ts)?.get(leg.e), meta, tsMs: ts, spotAtExpiry: spotBefore(leg.e) }));
        if (p) path.push({ ts, S: R.spot[base + k], delta: p.delta ?? 0,
          fs: fin(p.forwardUsd) && R.spot[base + k] > 0 ? p.forwardUsd / R.spot[base + k] : 1 });
        return p;
      },
      fundRateAt: fundRate,
      expiryMs: leg.e, entry: open, entryTsMs: R.times[i], entrySpot: S0, cfg: CFG,
    });
    if (!walk) { i += 1; continue; }
    const endIdx = base + walk.exitIndex;
    trades.push({ ts: R.times[i], exitTs: R.times[endIdx], endIdx, im, leg, open, walk, path,
      entryTs: R.times[i], entryS: S0, fs0: fin(leg.f) && S0 > 0 ? leg.f / S0 : 1 });
    i = endIdx + 1;
  }
}
if (!trades.length) { console.error("сделок не получилось"); process.exit(1); }

// ── прогон вариантов
const out = new Map(VARIANTS.map((v) => [v.key, { rows: [], diffTicks: 0, ticks: 0, diffTrades: 0 }]));
for (const t of trades) {
  let refDecisions = null;
  for (const v of VARIANTS) {
    const h = runHedge(v, t.path, t.entryTs, t.entryS,
      v.spotDelta ? t.leg.d * t.fs0 : t.leg.d, t.leg.e);
    if (v.ref) refDecisions = h.decisions;
    const s = settleSellTrade({ open: t.open, walk: { ...t.walk, ...h }, cfg: CFG });
    const acc = out.get(v.key);
    acc.rows.push({ ...s, reh: h.rehedges, im: t.im, retIm: (s.pnl / t.im) * 100, ts: t.ts });
    if (!v.ref) {
      let diff = 0;
      for (let k = 0; k < Math.max(h.decisions.length, refDecisions.length); k++) {
        if (h.decisions[k] !== refDecisions[k]) diff += 1;
      }
      acc.diffTicks += diff;
      acc.ticks += refDecisions.length;
      if (diff) acc.diffTrades += 1;
    }
  }
}

const equity = (rows) => {
  let eq = 1, peak = 1, dd = 0;
  for (const r of rows) { eq *= 1 + r.retIm / 100; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
  return { eq, dd: dd * 100 };
};

// ── ОТЧЁТ
console.log(`# Парная сверка: эталон против движка\n`);
console.log(`Запись ${DIR}: ${N} снимков, ${dt(R.times[0])} .. ${dt(R.times.at(-1))}.`);
console.log(`Цепочка эталона: ${trades.length} сделок, ${dt(trades[0].ts)} .. ${dt(trades.at(-1).exitTs)}.`);
console.log(`Полоса ${BAND} BTC на контракт · комиссия перпа ${(PERP_FEE * 1e4).toFixed(1)} б.п.`
  + `${CHAIN_ADJ !== 1 ? ` · поправка цепочки ×${CHAIN_ADJ}` : ""}.\n`);

// РАЗБРОС И ПРОСАДКА В ТОЙ ЖЕ ТАБЛИЦЕ, И ЭТО НЕ УКРАШЕНИЕ. Вариант, который поднял среднюю
// сделку, мог просто ВЕРНУТЬ направленную ставку, ради снятия которой хедж и заводился (дельта
// даёт 81% дисперсии итога и никакого преимущества). Без разброса рядом такой вариант читается
// как улучшение, хотя он размен риска на доходность и никем не выбран.
const sd = (a) => { const s = a.filter(fin); if (s.length < 2) return NaN; const m = mean(s);
  return Math.sqrt(s.reduce((x, y) => x + (y - m) ** 2, 0) / (s.length - 1)); };
console.log(`## 1 · Расхождение решений\n`);
console.log(`| вариант | тиков разошлось | сделок задето | перекладок | залог вырос в | средняя | разброс | просадка |`);
console.log(`|---|---|---|---|---|---|---|---|`);
const ref = out.get("ref");
const refEq = equity(ref.rows);
console.log(`| ${VARIANTS[0].label} | - | - | ${f2(mean(ref.rows.map((r) => r.reh)), 0)} | **${f2(refEq.eq)}** | `
  + `${f2(mean(ref.rows.map((r) => r.retIm)))}% | ${f2(sd(ref.rows.map((r) => r.retIm)))} | ${f2(refEq.dd, 1)}% |`);
for (const v of VARIANTS.slice(1)) {
  const a = out.get(v.key);
  const e = equity(a.rows);
  console.log(`| ${v.label} | ${a.diffTicks} (${f2((100 * a.diffTicks) / Math.max(1, a.ticks))}%) | ${a.diffTrades}/${trades.length} | `
    + `${f2(mean(a.rows.map((r) => r.reh)), 0)} | ${f2(e.eq)} | ${f2(mean(a.rows.map((r) => r.retIm)))}% | `
    + `${f2(sd(a.rows.map((r) => r.retIm)))} | ${f2(e.dd, 1)}% |`);
}

console.log(`\n## 2 · Статьи итога, USD на контракт за сделку\n`);
console.log(`| вариант | премия минус выкуп | хедж | издержки | фандинг | итого |`);
console.log(`|---|---|---|---|---|---|`);
for (const v of VARIANTS) {
  const rows = out.get(v.key).rows;
  const s = (k) => mean(rows.map((r) => r[k])) * (k === "cost" || k === "fund" ? -1 : 1);
  console.log(`| ${v.label} | ${f2(s("optLeg"), 0)} | ${f2(s("hedgeLeg"), 0)} | ${f2(s("cost"), 0)} | `
    + `${f2(s("fund"), 0)} | **${f2(mean(rows.map((r) => r.pnl)), 0)}** |`);
}

if (has("--trades")) {
  console.log(`\n## Сделки по одной строке (% залога)\n`);
  console.log(`| № | открыли | ${VARIANTS.map((v) => v.label).join(" | ")} |`);
  console.log(`|---|---|${VARIANTS.map(() => "---").join("|")}|`);
  trades.forEach((t, k) => {
    console.log(`| ${k + 1} | ${dt(t.ts)} | ${VARIANTS.map((v) => f2(out.get(v.key).rows[k].retIm)).join(" | ")} |`);
  });
}

console.log(`\n## Границы сверки\n`);
const allFs = trades.flatMap((t) => t.path.map((p) => p.fs));
console.log(`- отношение форварда к споту F/S: медиана ${f2(q(allFs, 0.5), 4)}, `
  + `p05 ${f2(q(allFs, 0.05), 4)}, p95 ${f2(q(allFs, 0.95), 4)} - это и есть цена вопроса`);
console.log(`  «дельта от форварда против перпа от спота»;`);
console.log(`- ${formatPriceStats(R.stats)}`);
console.log(`- сверяются РЕШЕНИЯ хеджа; выбор контракта и момент закрытия у всех вариантов общие`);
console.log(`  (их у живого движка нет вовсе: фаза S4 не начата, сверять нечего);`);
console.log(`- глубины перпа в записи нет: проскальзывание сверх комиссии не моделируется нигде;`);
console.log(`- полоса бота 2 задана АБСОЛЮТНЫМ числом (0.001 BTC) и с размером позиции не`);
console.log(`  масштабируется: здесь она приведена к контракту делением на лот ${LOT}.`);
