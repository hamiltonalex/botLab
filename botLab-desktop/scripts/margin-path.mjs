#!/usr/bin/env node
// margin-path.mjs - МАРЖИНАЛЬНЫЙ ПУТЬ ВНУТРИ СДЕЛОК схемы продавца по записи. READ-ONLY.
//
// ЗАЧЕМ. Эталон (hist-sellhedge.mjs) и симуляция счёта шагают ПО ГРАНИЦАМ сделок: размер
// проверяется на входе, P&L прибавляется на выходе. Вопрос «как высоко поднимается утилизация
// maintenance-маржи ВНУТРИ сделки» не считался нигде, а ответ на нём ломает вывод: при
// deployPct 0.70 маржинальный путь пересекал зону ликвидации реального счёта (MM ≥ 100% equity)
// в 13 сделках из 84 за пять лет с пиком 244% (ревизия 2026-08-25, худший эпизод
// BTC-27JAN23-17000-C перед январским ралли +47%). «×16 за 5 лет» верен только при допущении
// «биржа не ликвидирует внутри сделки», и это допущение при 0.70 ложно.
//
// КАК УСТРОЕН. Снабжение скопировано из replay-sellhedge.mjs (тот же загрузчик, та же сборка
// снимка); решения принимает ЖИВОЙ ДВИЖОК бота 2 (openStructure/ingest/evaluate), маржа берётся
// из его же cycle.account (structureMargin = формулы Deribit по коротким ногам). Маржа перпа НЕ
// моделируется, как и в приложении - реальный счёт СТРОЖЕ этой оценки.
//
// ДВА ПРАВИЛА РАЗМЕРА (Р2 ревизии 2026-08-25):
//   --deploys a,b,..    базовое правило lotsByMargin: лоты от ДОЛИ IM на входе (как в бою);
//   --size-rule stress  кандидат на замену: лоты от «MM при споте ×(1+X%) не выше cap·equity».
//                       Ограничивает именно то, что рвётся (хвост пути маржи), а не входную
//                       загрузку. Модель марка при стрессе та же, что у liqPriceEst движка:
//                       внутренняя стоимость на стресс-споте плюс ТЕКУЩАЯ временная.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gunzipSync } from "node:zlib";
import { priceAt, makePriceStats, countPrice } from "../src/engine/otmscan/hist-price.js";
import { shouldOpenNext } from "../src/engine/otmscan/sellhedge.js";
import { buildSellStructure } from "../src/engine/btcopt/structure.js";
import { lotsByStressMargin } from "../src/engine/btcopt/margin.js";
import * as s1engine from "../src/engine/btcopt/engine.js";

const fin = (x) => Number.isFinite(x);
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

if (args.includes("--help") || !argOf("--dir")) {
  console.log(`margin-path.mjs - маржинальный путь внутри сделок схемы продавца (живой движок)

  --dir <каталог>     запись восстановления (обязательно)
  --funding <файл>    почасовой фандинг перпа (по умолчанию из кэша hist-download)
  --deposit <$>       стартовый счёт (по умолчанию 20000)
  --expiry <a,b>      окно срока ноги в часах, уходит движку через sellCfg
                      (по умолчанию не передаётся - действует дефолт схемы 336,672)
  --deploys <a,b,..>  уровни deployPct базового правила (по умолчанию 0.70,0.50,0.40,0.30,0.25,0.20,0.15)
  --size-rule stress  замер правила размера от СТРЕСС-МАРЖИ вместо доли IM на входе
  --stress-x <a,b,..> проценты стресс-хода спота для --size-rule stress (по умолчанию 10,15,20,25,30)
  --stress-cap <x>    доля equity, которую MM на стресс-споте не должна превышать (по умолчанию 1.0)
  --worst <n>         сколько худших сделок печатать на строку таблицы (по умолчанию 5)`);
  process.exit(argOf("--dir") ? 0 : 1);
}

const DIR = argOf("--dir", join(homedir(), "botlab-hist-5y"));
const DEPOSIT = Number(argOf("--deposit", "20000"));
// Окно срока НЕ дублирует дефолт схемы: без флага sellCfg поля не несёт, и движок берёт своё
// (SELLHEDGE_DEFAULTS). Дублирование здесь означало бы два места, где живёт число 336-672.
const EXPW = (() => {
  const raw = argOf("--expiry");
  if (raw == null) return null;
  const [a, b] = raw.split(",").map(Number);
  if (!(a > 0) || !(b > a)) { console.error(`--expiry: ожидается «мин,макс» в часах, получено «${raw}»`); process.exit(1); }
  return { expiryMinH: a, expiryMaxH: b };
})();
const DEPLOYS = (argOf("--deploys", "0.70,0.50,0.40,0.30,0.25,0.20,0.15")).split(",").map(Number).filter(fin);
const SIZE_RULE = argOf("--size-rule", "deploy");
const STRESS_X = (argOf("--stress-x", "10,15,20,25,30")).split(",").map(Number).filter(fin);
const STRESS_CAP = Number(argOf("--stress-cap", "1.0"));
const WORST_N = Number(argOf("--worst", "5"));
const LOT = 0.01, PERP_CS = 10, BAND = 0.03;

// ── запись: загрузчик слово в слово тот же, что у эталона и прогона движка (слой снабжения общий).
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
  const tickIdx = times.map((t) => {
    let lo = 0, hi = tts.length - 1, res = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (tts[m] <= t) { res = m; lo = m + 1; } else hi = m - 1; }
    return res;
  });
  const spot = tickIdx.map((k) => (k == null ? null : ticks[k]?.S ?? null));
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
    } catch { /* следующий путь */ }
  }
}
const fundRate = (ts) => FUND.get(Math.floor(ts / 3600000) * 3600000) ?? 0;
const spotBefore = (T) => { let lo = 0, hi = N - 1, res = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (R.times[m] <= T) { res = R.spot[m]; lo = m + 1; } else hi = m - 1; } return res; };

// ── сборка снимка: контракт buildDeribitSnapshot, цена открытой ноги лестницей hist-price.
function buildSnapshot(i, openLeg) {
  const ts = R.times[i];
  const S = R.spot[i];
  const snap = R.snaps.get(ts);
  const legs = {};
  const chain = [];
  for (const r of snap.values()) {
    if (!(r.m > 0)) continue;
    chain.push({
      instrument_name: r.n, strike: r.k, expiration_timestamp: r.e,
      option_type: r.s === "C" ? "call" : "put", contract_size: 1, min_trade_amount: LOT, tick_size: 0.5,
    });
    legs[r.n] = {
      instrument: r.n, type: r.s === "C" ? "call" : "put", strike: r.k, expiryMs: r.e,
      bid: r.b, ask: r.a, mark: r.m, markIv: r.iv, delta: r.d, gamma: null, vega: r.vg, theta: r.th,
      underlying: S, index: S, contractSize: 1, tickSize: 0.5, minTradeAmount: LOT, markInUsd: true, ts,
    };
  }
  let gateOk = true;
  if (openLeg) {
    const p = countPrice(R.stats, priceAt({
      snapshot: snap, expiryRows: R.byExp.get(ts)?.get(openLeg.expiryMs),
      meta: { name: openLeg.instrument, expiryMs: openLeg.expiryMs, strikeUsd: openLeg.strike, type: "C" },
      tsMs: ts, spotAtExpiry: spotBefore(openLeg.expiryMs),
    }));
    if (!p) gateOk = false;
    else {
      const prev = legs[openLeg.instrument] ?? {};
      legs[openLeg.instrument] = {
        ...prev, instrument: openLeg.instrument, type: "call", strike: openLeg.strike,
        expiryMs: openLeg.expiryMs, mark: p.markUsd, delta: p.delta, markIv: p.ivPct,
        underlying: S, index: S, contractSize: 1, minTradeAmount: LOT, markInUsd: true, ts,
      };
    }
  }
  const perp = {
    instrument: "BTC-PERPETUAL", mark: S, index: S, bid: S, ask: S,
    funding8h: fundRate(ts) * 8, inverse: true, contractSize: PERP_CS, tickSize: 0.5, minTradeAmount: 10, ts,
  };
  return {
    ts, underlying: S, index: S, legs, perp,
    liquidity: { bid: S, ask: S, mid: S, halfSpread: 0 },
    fresh: { ageSec: 0, stale: false, ok: gateOk, gateOk, gateFailed: [], source: "replay", notes: [] },
    chain,
  };
}

const settings = {
  benefitMovePct: 0.5, execStyle: "limit", makerFeeRate: 0, takerFeeRate: 0,
  slippageRate: 0.0002, fundingMaxGapSec: 1e9, paperEquityUsd: DEPOSIT, qty: LOT,
};
const sanityCfg = { ageMode: "off", spreadMode: "off", depthMode: "off" };

// Лоты правила стресс-маржи считает ДВИЖОК (lotsByStressMargin в btcopt/margin.js): правило
// 2026-08-26 переехало из этого скрипта в код вместе с фиксацией констант, и здесь остался только
// вызов. Для короткого колла двухсторонняя формула движка совпадает с прежней односторонней
// (связывает всегда верхняя сторона), поэтому исторические таблицы этого режима воспроизводятся.
// strike/mark приходят из structure.pickedLeg (та нога, которую выбрал движок).
const stressLots = ({ strike, mark, S, equity, xPct, capFrac }) =>
  lotsByStressMargin({ legs: [{ type: "call", strike, mark }], indexUsd: S,
    equityUsd: equity, xPct, capFrac, lot: LOT });

// ── прогон одной конфигурации размера через живой движок.
//   sizing = { kind: "deploy", pct } | { kind: "stress", xPct, capFrac }
function run(sizing) {
  const sellCfg = { bandBtc: BAND, lot: LOT, execModel: "maker-mid",
    ...(EXPW ?? {}),
    ...(sizing.kind === "deploy" ? { deployPct: sizing.pct } : {}) };
  const st = s1engine.create({ nowMs: R.times[0], settings });
  const trades = [];
  let open = null, skipped = 0;
  let eqPeak = DEPOSIT, maxDd = 0, minEq = DEPOSIT;
  for (let i = 0; i < N; i++) {
    const S = R.spot[i];
    if (!(S > 0)) continue;
    const ts = R.times[i];
    const snapshot = buildSnapshot(i, open?.leg ?? null);
    s1engine.ingest(st, snapshot, ts);
    const hadStructure = !!st.structure;
    if (shouldOpenNext({ hasStructure: hadStructure, chainOn: true, stopRequested: false })) {
      // Правило стресс-маржи считает лоты СНАРУЖИ движка (это замер кандидата, а не боевой код):
      // чистой пробой buildSellStructure узнаётся нога, которую выберет движок, затем размер
      // передаётся явным qty. Проба и открытие детерминированно выбирают одну и ту же ногу -
      // тот же снимок, тот же cfg, та же функция. Ветка НЕ прерывает тик (`continue` пропустил
      // бы evaluate и сломал паритет учёта с базовой веткой): решение только о попытке открытия.
      let attempt = true, qty = null;
      if (sizing.kind === "stress") {
        const probe = buildSellStructure({ qty: LOT, sellCfg, sanityCfg }, snapshot.chain, snapshot, ts);
        if (probe.error) attempt = false; // нет ноги или издержек - как безуспешная попытка движка
        else {
          const equity = s1engine.account(st, snapshot).equity;
          const { lots } = stressLots({ strike: probe.pickedLeg.strike, mark: probe.pickedLeg.mark,
            S, equity, xPct: sizing.xPct, capFrac: sizing.capFrac });
          if (lots < 1) { skipped += 1; attempt = false; } // счёт не даёт лота - как «не помещается»
          else qty = lots * LOT;
        }
      }
      const res = attempt
        ? s1engine.openStructure(
            st, { kind: "sell-call", qty, execStyle: "limit", sellCfg, sanityCfg },
            snapshot.chain, snapshot, ts,
          )
        : { error: "skip" };
      if (res.error) {
        if (String(res.error).includes("не помещается в счёт")) skipped += 1;
      } else {
        const l = res.structure.legs[0];
        open = {
          leg: { instrument: l.instrument, strike: l.strike, expiryMs: l.expiryMs },
          openTs: ts, lots: res.structure.sizing?.lots ?? null,
          imAtOpen: res.structure.sizing?.imUsedUsd ?? null,
          eqAtOpen: null, peakMM: 0, peakIM: 0, minEqTrade: Infinity,
        };
      }
    }
    const cycle = s1engine.evaluate(st, snapshot, ts);
    const eq = cycle.account.equity;
    eqPeak = Math.max(eqPeak, eq);
    maxDd = Math.max(maxDd, (eqPeak - eq) / eqPeak);
    minEq = Math.min(minEq, eq);
    if (st.structure && open) {
      if (open.eqAtOpen == null) open.eqAtOpen = eq;
      open.peakMM = Math.max(open.peakMM, cycle.account.maintenance_utilisation);
      open.peakIM = Math.max(open.peakIM, cycle.account.initial_utilisation);
      open.minEqTrade = Math.min(open.minEqTrade, eq);
    }
    if (open && !st.structure) { // экспирация закрыла сделку внутри evaluate этого тика
      trades.push(open);
      open = null;
    }
  }
  const acct = s1engine.account(st, buildSnapshot(N - 1, null));
  return { trades, skipped, finalEq: acct.equity, maxDd, minEq };
}

// ── отчёт
const pct = (x, d = 1) => (fin(x) ? (100 * x).toFixed(d) + "%" : "н/д");
const modes = SIZE_RULE === "stress"
  ? STRESS_X.map((x) => ({ label: `MM@+${x}% ≤ ${STRESS_CAP.toFixed(2)}·eq`, sizing: { kind: "stress", xPct: x, capFrac: STRESS_CAP } }))
  : DEPLOYS.map((d) => ({ label: d.toFixed(2), sizing: { kind: "deploy", pct: d } }));
console.log(`# Маржинальный путь внутри сделок (запись ${DIR}, ${N} снимков, депозит $${DEPOSIT})\n`);
if (EXPW) console.log(`Окно срока ноги: ${EXPW.expiryMinH}-${EXPW.expiryMaxH} ч (через sellCfg; дефолт схемы 336-672).\n`);
console.log(SIZE_RULE === "stress"
  ? `Правило размера: лоты от СТРЕСС-МАРЖИ - максимум q, при котором MM на споте ×(1+X%) не выше ${STRESS_CAP.toFixed(2)}·equity (Р2 ревизии 2026-08-25).\n`
  : `Правило размера: боевое lotsByMargin - лоты от доли IM на входе (deployPct).\n`);
console.log(`| правило | сделок | проп. | конец | рост | просадка eq | пик MM | сделок MM≥80% | ≥90% | ≥100% | пик IM |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);
for (const m of modes) {
  const r = run(m.sizing);
  const peakMM = r.trades.length ? Math.max(...r.trades.map((t) => t.peakMM)) : NaN;
  const peakIM = r.trades.length ? Math.max(...r.trades.map((t) => t.peakIM)) : NaN;
  const c80 = r.trades.filter((t) => t.peakMM >= 0.8).length;
  const c90 = r.trades.filter((t) => t.peakMM >= 0.9).length;
  const c100 = r.trades.filter((t) => t.peakMM >= 1.0).length;
  console.log(`| ${m.label} | ${r.trades.length} | ${r.skipped} | $${r.finalEq.toFixed(0)} | ×${(r.finalEq / DEPOSIT).toFixed(1)} | ${pct(r.maxDd)} | ${pct(peakMM)} | ${c80} | ${c90} | ${c100} | ${pct(peakIM)} |`);
  const worst = [...r.trades].sort((a, b) => b.peakMM - a.peakMM).slice(0, WORST_N);
  for (const t of worst) {
    console.log(`|   худшие: ${t.leg.instrument} ${new Date(t.openTs).toISOString().slice(0, 10)} лотов ${t.lots} | | | | | | MM ${pct(t.peakMM)} | IM ${pct(t.peakIM)} | eq мин $${t.minEqTrade.toFixed(0)} | | |`);
  }
}
console.log(`\nГраницы: маржа перпа НЕ моделируется (как в приложении) - реальный счёт строже; MM ≥ 100% =`);
console.log(`зона ликвидации реального счёта; путь маржи меряется шагом записи (час) - внутричасовые пики не видны.`);
