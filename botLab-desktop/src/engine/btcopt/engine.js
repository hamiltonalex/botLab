// engine.js — «BTC-опционы» (Dmitri Marinkin Strategy One) paper engine CORE.
// PURE: no electron / DOM / fs / fetch — deterministic, unit-testable. Isolated from the
// funding-arb engine (paper.js/ledger.js are carry-accrual only; options P&L is mark-to-market).
//
// The strategy: a 4-leg BTC options "winged straddle" (long ATM call + long ATM put + short OTM call
// + short OTM put), one expiry, delta-hedged with a BTC perpetual. Greeks come FROM Deribit
// (public/ticker); this module never prices options itself. The option legs are LINEAR USDC
// (BTC_USDC-*, marks in USD); the hedge leg is the INVERSE BTC-PERPETUAL ($10 contract) — the perp's
// inverse mark-to-market / funding is localized to hedge.js/pnl.js.
//
// This module composes the pure sub-modules into the tick lifecycle:
//   ingest(state, snapshot, nowMs)   — accrue funding on the held perp; stamp clocks.
//   evaluate(state, snapshot, nowMs) — net greeks + hedge decision + (paper) fill + P&L → the cycle-snapshot.
//   openStructure / closeStructure   — manual entry / exit.
//   account                          — paper equity/margin estimate.
// All time-dependent behaviour takes an explicit nowMs (never Date.now()) so tests are reproducible.

import { buildStructure, buildSellStructure, optionDeltaTotal, netGreeks, netDebit, pickExpiry, structureRejections } from "./structure.js";
import { payoffCurve, payoffAt } from "./payoff.js";
import { decideHedge, applyFill, settlementBlackout } from "./hedge.js";
import { markStructure, markPerp, accrueFunding, attribute, noHedgeAttribute, appendLedger } from "./pnl.js";
import { initMetrics, foldCycle, summarize } from "./metrics.js";
import { structureMargin } from "./margin.js";
import { computeScenarios } from "./stress.js";
import { computeRegime } from "./regime.js";
import { SELLHEDGE_DEFAULTS, sellhedgeEngineCfg, shouldOpenDegraded } from "../otmscan/sellhedge.js";
import { SELL_SANITY_DEFAULTS } from "../otmscan/sanity.js";

export const BOT_ID = "btc-options";
export const SCHEMA_VERSION = 1;

// Cost-model rates + blackout windows the hedge engine needs but that aren't user-facing knobs. Merged
// under the persisted settings at evaluate time (settings win if they ever override one).
const HEDGE_CONSTANTS = {
  takerFeeRate: 0.0005, // 5 bps taker (Deribit illustrative)
  makerFeeRate: 0, // Deribit BTC-perp maker 0.00% — the limit (post-only) execution branch
  slippageRate: 0.0002, // flat slippage rate on the perp mark
  fundingHorizonSec: 28800, // one 8h funding period
  dailyWindowSec: 600, // ±10 min around 08:00 UTC settlement
  preExpirySec: 1800, // last 30 min before expiry
  fundingMaxGapSec: 300, // anti-catch-up clamp for a sleep/wake gap
};

// Merge the persisted user settings over the engine cost constants → the cfg the hedge engine consumes.
function buildCfg(settings) {
  return { ...HEDGE_CONSTANTS, ...(settings || {}) };
}

// The canonical preset → ±BTC half-width table. Single source of truth: the settings toolbar (via
// normalizeDeadband at the s1:setSettings boundary) and the sweep grid both read THIS table, so the
// preset label and the width the hedge engine actually uses can never drift apart again.
// ЗНАЧЕНИЯ ЗАДАНЫ НА КАЛИБРОВОЧНОМ РАЗМЕРЕ deadbandRefQty (0.01), а не на контракте: полосу
// масштабирует effectiveDeadband. Чтобы прочитать пресет «на 1.0 контракта», умножьте на 100.
export const DEADBAND_PRESETS = {
  // Полоса схемы продажи колла: 0.03 BTC НА КОНТРАКТ, то есть 0.0003 на калибровочном размере.
  // Число не выбрано на глаз и не универсально: оно найдено перебором сетки против стоимости
  // перекладки и от неё ЗАВИСИТ (sellhedge.js: при мейкере теснее всегда лучше, при 10 б.п. лучше
  // шире, а 0.01 даёт ×0.98). 0.03 это оптимум при реалистичных 2.5 б.п. Оставлять схему на
  // ближайшем пресете было бы подменой: самый тесный из прежних (0.05 на контракт) шире
  // калиброванной в 1.67 раза, и хедж шёл бы не по тому правилу, каким схема измерена.
  sellhedge: 0.0003,
  aggressive: 0.0005,
  normal: 0.001,
  conservative: 0.002,
};

// Normalize a settings patch: a known deadbandPreset that arrives WITHOUT its width gains the table
// width; an explicit deadbandBtc in the same patch always wins (sweep-apply and custom sweep grids
// send consistent pairs and must stay byte-identical). Unknown preset → patch returned untouched.
export function normalizeDeadband(patch) {
  const p = patch || {};
  const width = DEADBAND_PRESETS[p.deadbandPreset];
  if (width == null || p.deadbandBtc != null) return p;
  return { ...p, deadbandBtc: width };
}

// Default engine/strategy settings (spec defaults). Persisted to <BOT_ID>-settings.json.
// qty default is the linear-USDC option minimum (0.01) — right-sized for the $100 paper deposit.
export function defaultSettings() {
  return {
    deadbandPreset: "normal", // aggressive | normal | conservative
    deadbandBtc: 0.001, // ±BTC (normal preset), calibrated at deadbandRefQty below
    // The structure size deadbandBtc is calibrated at; the band scales linearly with the actual size
    // from here (effectiveDeadband in hedge.js). Default = qty below, so a live profile's effective
    // band is exactly its setting and nothing changes until the operator opens a DIFFERENT size.
    // Re-anchoring this is a calibration decision with real cost consequences, so it is a setting
    // rather than a constant: at qty 1 the same 0.001 means a band 100x tighter in relative terms.
    deadbandRefQty: 0.01,
    priceTriggerPct: 0.5, // % move since last hedge that arms the price trigger
    // The move the benefit estimate is measured against. Equal to priceTriggerPct by default, so the
    // default configuration is unchanged, but it is now a SEPARATE knob: one number used to mean both
    // "when does the price trigger fire" and "how big a move is the hedge worth", which made the two
    // impossible to tune (or even measure) apart. See benefitMoveFrac in hedge.js.
    benefitMovePct: 0.5,
    rehedgeSec: 60, // time-trigger interval (a prompt to re-price, not a must-trade)
    lambda: 1.25, // hedge cost multiplier (gate: benefit > cost * lambda)
    repriceSec: 15, // Deribit poll cadence (source owns the timer); one of the toolbar presets 5/15/30
    callOffsetPct: 10, // short call strike ~ spot * (1 + off)
    putOffsetPct: 10, // short put  strike ~ spot * (1 - off)
    qty: 0.01, // option contracts per leg (Deribit BTC_USDC min lot = 0.01; validated at open)
    execStyle: "limit", // limit (post-only) | market
    settlementBlackout: true, // pause hedging at 08:00 UTC settlement + last 30 min before expiry
    testnet: false, // public data source: prod (www.deribit.com) vs test.deribit.com
    paperEquityUsd: 100, // starting paper deposit (USD); equity = this + cumulative net P&L
    marginAlertPct: 0.8, // alert when maintenance-margin utilisation ≥ this fraction of equity (Phase 2c)
    ivWindowSec: 86400, // IV-regime rolling window (Phase 3b) — rank ATM IV within the last 24h
    ivEntryMaxRank: 0.35, // entry favorable when IV-rank ≤ this (long-vol thesis: enter when IV is LOW)
  };
}

// The persisted paper state — must round-trip cleanly through JSON.stringify/parse.
export function create(params) {
  params = params || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    botId: BOT_ID,
    createdAt: params.nowMs ?? null, // stamped by the caller (no Date.now() in a pure module)
    settings: { ...defaultSettings(), ...(params.settings || {}) },
    structure: null, // the open 4-leg structure (set by openStructure())
    perpState: { qty: 0, avgEntry: 0, feesCum: 0, fundingCum: 0, realizedUsd: 0, fundingGapSec: 0 }, // inverse BTC-perp hedge (qty in $10 contracts); fundingGapSec - А6 R3, см. ingest
    realizedOptionsUsd: 0, // option MtM locked in by closed structures (cumulative)
    ledger: [], // cumulative hedge/accrual/open/close events — independent of any exchange session reset
    lastHedgeAt: null, // ms of the last executed hedge (time/price trigger baseline)
    lastHedgeUnderlying: null, // BTC price at the last hedge (price trigger baseline)
    lastIngestAt: null, // ms of the last ingest (funding-accrual dt baseline)
    lastUnderlying: null, // last seen BTC price
    metrics: initMetrics(), // run-metrics accumulators (Phase 2b) — O(1) scalars, reset at each structure open
    lastRunMetrics: null, // frozen summary of the LAST finished run — the only survivor of openStructure's metrics reset
    // ЦЕПОЧКА СХЕМЫ ПРОДАВЦА. Отдельный накопитель нужен потому, что `metrics` обнуляется КАЖДЫМ
    // открытием, а `lastRunMetrics` хранит ровно одну прошлую сделку: на вопрос «схема из
    // семнадцати сделок работает или нет» ответить было нечем. Леджер накопительный, то есть данные
    // были, но их никто не считал. `trades` пишется на КАЖДУЮ проданную ногу, открытую цепочкой или
    // руками: разделять их значило бы прятать от оператора часть его же истории.
    // `mode`: "continuous" | "once" (одна сделка, после расчёта перевхода нет); отсутствующее в
    // старом персисте поле читается как непрерывный режим. `sanityWaitingSince` - начало ожидания
    // санитарии (ни одна нога не прошла); переживает рестарт намеренно: перерыв в поиске ноги не
    // должен обнуляться перезапуском приложения.
    sellChain: { on: false, stopRequested: false, armedAt: null, stoppedAt: null, params: null, trades: [], mark: null, mode: "continuous", sanityWaitingSince: null },
  };
}

// Окно ожидания санитарии (§1.8): begin ставится вызывающим при отказе «ни одна нога не прошла»,
// clear - при любом успешном открытии продавца. Отдельными функциями, потому что отказ виден
// вызывающему (openStructure возвращает ошибку), а состояние живёт в движке и персистится.
export function sellChainSanityWaitBegin(state, nowMs) {
  if (state.sellChain && state.sellChain.sanityWaitingSince == null) state.sellChain.sanityWaitingSince = nowMs;
}
export function sellChainSanityWaitClear(state) {
  if (state.sellChain) state.sellChain.sanityWaitingSince = null;
}

// Reconciliation/risk monitor only (never drives hedging): Deribit's account delta_total ≈
// Σ qᵢ·(BS δᵢ − mark_in_BTC) + futures. For linear USDC options mark is USD → convert at the index.
function exchangeDeltaTotal(structure, snapshot, Qperp) {
  if (!structure) return Qperp;
  const idx = snapshot.index || snapshot.underlying || 0;
  let ntd = 0;
  for (const l of structure.legs) {
    const g = snapshot.legs?.[l.instrument];
    if (!g) continue;
    const markBtc = l.markInUsd && idx ? (g.mark ?? 0) / idx : g.mark ?? 0;
    ntd += l.qtySigned * ((g.delta ?? 0) - markBtc);
  }
  return ntd + Qperp;
}

// ── Ingest: accrue funding on a held perp, refresh clocks. Called once per market tick before evaluate.
// А6 R3 (ратифицировано 2026-07-20): время сверх анти-catch-up клампа (fundingMaxGapSec) больше не
// исчезает молча - оно копится в perpState.fundingGapSec (аддитивное поле, паттерн gapSkippedSec
// funding-arb) и оставляет строку funding-gap в леджере (нулевые суммы, только видимость - закон
// §7 «деградация видима»). Сам кламп НЕ меняется: оценивать многочасовой разрыв текущей
// мгновенной ставкой было бы неверно, отказ от оценки - правильная механика.
export function ingest(state, snapshot, nowMs) {
  const cfg = buildCfg(state.settings);
  if (state.perpState.qty !== 0 && snapshot.perp && Number.isFinite(snapshot.perp.funding8h)) {
    const last = state.lastIngestAt ?? nowMs;
    const dtSec = Math.max(0, (nowMs - last) / 1000);
    if (dtSec > 0) {
      const res = accrueFunding(state.perpState, snapshot.perp, dtSec, { maxDtSec: cfg.fundingMaxGapSec });
      if (res.gapSkippedSec > 0) {
        state.perpState.fundingGapSec = (state.perpState.fundingGapSec || 0) + res.gapSkippedSec;
        appendLedger(state, {
          t: nowMs,
          type: "funding-gap",
          note: `разрыв тиков ${Math.round(dtSec)}с: фандинг начислен за ${cfg.fundingMaxGapSec}с, ${Math.round(res.gapSkippedSec)}с не оценены (анти-catch-up кламп)`,
        });
      }
    }
  }
  // ── НЕПРЕРЫВНОСТЬ ОПРОСА. Считается ТОЛЬКО пока открыта проданная нога, и это самый дорогой из
  // измеренных рисков схемы: каданс решения раз в сутки роняет пятилетний результат с роста залога
  // в 46.5 раза до 16.2, а просадку поднимает с 13.5% до 30.6%. Ни одного поля покрытия у бота 2 не
  // было, то есть оператор не мог отличить схему, которая хеджилась каждые 15 секунд, от схемы,
  // которая проспала четыре часа. Накопитель O(1) плюс короткий список перерывов: держать все тики
  // не нужно, а перерыв без метки времени нельзя ни объяснить, ни опровергнуть.
  if (state.structure?.kind === "sell-call" && state.sellChain) {
    const u = state.sellChain.uptime ?? (state.sellChain.uptime = { ticks: 0, firstAt: nowMs, lastAt: null, maxGapMs: 0, gaps: [] });
    const prev = u.lastAt;
    u.ticks += 1;
    if (prev != null) {
      const gap = nowMs - prev;
      if (gap > u.maxGapMs) u.maxGapMs = gap;
      // Перерывом считается пропуск, а не дрожание таймера: порог в пять номинальных интервалов это
      // тот же критерий несвежести, каким источник помечает данные устаревшими.
      const nominalMs = Math.max(1000, (cfg.repriceSec || 15) * 1000);
      if (gap > nominalMs * 5) {
        u.gaps.push({ at: prev, ms: gap, lost: Math.max(0, Math.round(gap / nominalMs) - 1) });
        if (u.gaps.length > 50) u.gaps.shift(); // хвост важнее головы: свежие перерывы объяснимы
      }
    }
    u.lastAt = nowMs;
    u.nominalSec = cfg.repriceSec || 15;
  }
  state.lastIngestAt = nowMs;
  state.lastUnderlying = snapshot.underlying;
  return state;
}

// uptimeStats(state) - покрытие опроса за жизнь ОТКРЫТОЙ сделки. Чистая.
// ОЖИДАЕМЫЕ СЛОТЫ СЧИТАЮТСЯ ВКЛЮЧИТЕЛЬНО ПО ОБОИМ КОНЦАМ (span/шаг + 1), и это не придирка: без
// единицы на коротких окнах выходят ложные проценты выше ста, на чём проект уже обжигался при
// замере покрытия сканера.
export function uptimeStats(state) {
  const u = state.sellChain?.uptime;
  if (!u || u.lastAt == null) return null;
  const nominalMs = Math.max(1000, (u.nominalSec || 15) * 1000);
  const spanMs = Math.max(0, u.lastAt - u.firstAt);
  const expected = Math.floor(spanMs / nominalMs) + 1;
  const lostSlots = u.gaps.reduce((s, g) => s + g.lost, 0);
  return {
    ticks: u.ticks,
    expected,
    coveragePct: expected > 0 ? Math.min(100, (u.ticks / expected) * 100) : null,
    // Эффективный каданс это СРЕДНИЙ интервал между решениями: именно он ложится на измеренную
    // таблицу 4ч/12ч/24ч. Номинал таймера сюда не годится - он врёт ровно на величину простоя.
    effectiveSec: u.ticks > 1 ? spanMs / (u.ticks - 1) / 1000 : null,
    nominalSec: u.nominalSec || 15,
    maxGapMs: u.maxGapMs,
    lostSlots,
    gaps: u.gaps.slice(-10).reverse(),
    spanMs,
  };
}

// ── Evaluate: the full per-cycle computation → the §5 cycle-snapshot (drives the whole view).
// Recomputes net greeks, runs the hedge decision, executes a paper fill on HEDGE, and attributes P&L.
export function evaluate(state, snapshot, nowMs) {
  // Expiry settlement runs FIRST — before anything reads state.structure — so a tick that crosses the
  // expiry settles the book and the rest of the cycle computes flat (no hedging a dead structure).
  if (state.structure && nowMs >= state.structure.expiryMs) settleStructure(state, snapshot, nowMs);
  const structure = state.structure;
  // Engine params are FROZEN at structure open (the running structure hedges by the params it was
  // opened with; the live toolbar settings only drive the Zone-Ⅰ hypothesis until the next open).
  const cfg = buildCfg(structure?.engineCfg ?? state.settings);
  const perp = snapshot.perp || null;
  const gateOk = snapshot.fresh?.gateOk !== false;

  const optionDelta = structure ? optionDeltaTotal(structure, snapshot) : 0;
  const greeks = structure ? netGreeks(structure, snapshot) : { delta: 0, gamma: 0, vega: 0, theta: 0 };
  const mp = markPerp(state.perpState, perp || {});
  // Qperp = ДОЛЛАРОВАЯ дельта перпа (qty·cs/avgEntry), а не его номинал в BTC: нейтральность
  // сводится в той же системе отсчёта, в какой считается P&L опционов. Разбор конвенций и замер,
  // поймавший подмену, в шапке markPerp (pnl.js).
  const Qperp = mp.futuresDeltaBtc;
  const totalDelta = optionDelta + Qperp;
  const liquidity =
    snapshot.liquidity ||
    { bid: perp?.bid ?? null, ask: perp?.ask ?? null, mid: perp?.bid != null && perp?.ask != null ? (perp.bid + perp.ask) / 2 : perp?.bid ?? perp?.ask ?? null, halfSpread: 0 };
  const step = perp && perp.mark ? perp.contractSize / perp.mark : 0; // BTC per $10 contract

  // Hedge decision. Only run when a structure is open, the perp is priced, and the greeks gate is OK;
  // otherwise stand pat (a degraded snapshot must never trigger a trade on bad data).
  let decision;
  if (structure && perp && step > 0 && gateOk) {
    decision = decideHedge({
      optionDelta,
      Qperp,
      snapshot,
      liquidity,
      cfg,
      nowMs,
      expiryMs: structure.expiryMs,
      createdAt: structure.createdAt,
      lastHedgeAt: state.lastHedgeAt,
      lastHedgeUnderlying: state.lastHedgeUnderlying,
      step,
      // Размер структуры масштабирует полосу: закон равных ног даёт одну величину на все четыре.
      structureQty: structure.legs[0]?.qtyAbs ?? cfg.qty,
    });
  } else {
    decision = {
      decision: "SKIP",
      trigger_reason: [],
      estimated_cost: null,
      estimated_benefit: 0,
      hedge_order: null,
      target_futures_delta: -optionDelta,
      delta_excess: Math.max(0, Math.abs(totalDelta) - cfg.deadbandBtc),
      // Структуры нет - масштабировать нечем, полоса равна настройке.
      deadband_btc: cfg.deadbandBtc,
      blackout: { active: false, reason: null },
    };
  }

  // ── Cycle fields are a PRE-fill decision snapshot: the spec's sample cycle-JSON reports
  // current_futures_delta as the pre-hedge value, then the hedge takes visible effect next tick.
  // Capture the pre-fill position, price-move and P&L now; the fill is applied below as a side-effect.
  const perp_position = {
    contracts: state.perpState.qty,
    // РАЗМЕР позиции показывается номиналом по текущей цене - это то, что видно в терминале
    // Deribit. Дельта той же позиции лежит рядом в current_futures_delta и с ней НЕ совпадает,
    // пока цена не равна среднему входу (разбор в шапке markPerp).
    btc: mp.futuresNotionalBtc,
    avgEntry: state.perpState.avgEntry,
    notionalUsd: mp.notionalUsd,
    upl_usd: mp.upl_usd,
  };
  const priceMovePct =
    state.lastHedgeUnderlying && Number.isFinite(snapshot.underlying)
      ? (100 * Math.abs(snapshot.underlying - state.lastHedgeUnderlying)) / state.lastHedgeUnderlying
      : 0;
  const pnl = attribute(state, snapshot);
  const acct = account(state, snapshot);

  // ── Hedge vs no-hedge (Phase 2a): a real shadow book (perpQty ≡ 0) run in parallel. Its net is the
  // options-only, after-costs outcome; hedge_contribution is the hedge program's true net contribution
  // (perp realized + funding − perp fees) — positive means hedging helped after costs, negative means it
  // only cost money (a common outcome on tiny size). Derived, stored nowhere, appends no ledger row.
  const shadow = noHedgeAttribute(state, snapshot);
  const hedgeContribution = pnl.net_total - shadow.net_total;
  const hedge_vs = {
    hedged_net: pnl.net_total,
    no_hedge_net: shadow.net_total,
    hedge_contribution: hedgeContribution,
    components: { futures_upl: pnl.futures_upl, funding_total: pnl.funding_total, perp_fees: pnl.fees_total },
    helped: hedgeContribution > 0,
  };

  const option_legs = structure
    ? structure.legs.map((l) => {
        const g = snapshot.legs?.[l.instrument] || {};
        const mark = g.mark ?? l.entryMark ?? null;
        return {
          instrument: l.instrument,
          type: l.type,
          side: l.side,
          strike: l.strike,
          qty: l.qtySigned,
          bid: g.bid ?? null,
          ask: g.ask ?? null,
          mark,
          mark_iv: g.markIv ?? null,
          delta: g.delta ?? null,
          gamma: g.gamma ?? null,
          vega: g.vega ?? null,
          theta: g.theta ?? null,
          delta_contrib: l.qtySigned * (g.delta ?? 0),
          value_usd: l.qtySigned * (mark ?? 0) * l.contractSize,
        };
      })
    : [];

  const payoff =
    structure && Number.isFinite(snapshot.underlying)
      ? payoffCurve(structure, { min: snapshot.underlying * 0.75, max: snapshot.underlying * 1.25, n: 96 })
      : null;

  // ── Side-effect: execute the paper fill on HEDGE (takes effect next tick), book it, advance clocks.
  // Fill price follows the order's execution style: market crosses the spread (buy@ask / sell@bid);
  // limit (post-only) fills at MID — a deliberate proxy that grants half the passive-price edge in
  // exchange for the unmodeled non-fill risk of a real resting order. applyFill picks the fee rate
  // (maker vs taker) off the same order_type, so price and fee can't disagree.
  if (decision.decision === "HEDGE" && decision.hedge_order && perp) {
    const priceRef =
      decision.hedge_order.order_type === "limit"
        ? liquidity.mid ?? perp.mark
        : decision.hedge_order.side === "buy"
          ? liquidity.ask ?? perp.mark
          : liquidity.bid ?? perp.mark;
    const fill = applyFill(state.perpState, decision.hedge_order, priceRef, perp, cfg);
    state.lastHedgeAt = nowMs;
    state.lastHedgeUnderlying = snapshot.underlying;
    appendLedger(state, {
      t: nowMs,
      type: "hedge",
      side: decision.hedge_order.side,
      contracts: fill.filledContracts,
      priceRef,
      deltaBtc: (decision.hedge_order.side === "buy" ? 1 : -1) * decision.hedge_order.amount_rounded_btc,
      feeUsd: fill.feeUsd,
      realizedUsd: fill.realizedUsd,
      note: decision.trigger_reason.join("+"),
    });
  }

  // The last executed hedge (decision panel's "последний хедж") — derived from the ledger AFTER the
  // fill, so it reflects this tick's hedge even though the position fields above are pre-fill.
  const lastHedgeEv = [...state.ledger].reverse().find((e) => e.type === "hedge");
  const lastHedge = lastHedgeEv
    ? { seq: lastHedgeEv.seq, t: lastHedgeEv.t, side: lastHedgeEv.side, amount_rounded_btc: Math.abs(lastHedgeEv.deltaBtc), priceRef: lastHedgeEv.priceRef, realizedUsd: lastHedgeEv.realizedUsd }
    : null;

  // ── Run metrics (Phase 2b): fold this reprice cycle into the O(1) accumulators. Only while a
  // structure is open (idle flat ticks would dilute Sharpe/hit-rate). maintUtil is wired in 2c.
  if (typeof state.metrics?.n !== "number") state.metrics = initMetrics(); // forward-migrate old {} state
  // Профиль, записанный до появления цепочки, поднимается без неё: накопитель заводится пустым, а
  // не роняет тик. Сделки, закрытые ДО этой версии, в цепочку не попадают - восстановить их из
  // леджера можно, но это была бы вторая реализация того же счёта.
  if (!Array.isArray(state.sellChain?.trades))
    state.sellChain = { on: false, stopRequested: false, armedAt: null, stoppedAt: null, params: null, trades: [], mark: null };
  if (structure) {
    foldCycle(state.metrics, {
      net: pnl.net_total,
      totalDelta,
      decision: decision.decision,
      hedgeSizeBtc: decision.hedge_order?.amount_rounded_btc ?? 0,
      feesCum: state.perpState.feesCum,
      fundingCum: state.perpState.fundingCum,
      maintUtil: acct.maintenance_utilisation,
    });
  }

  // ── Stress scenarios (Phase 2d): pure what-if from net greeks + payoff geometry. Deterministic.
  const stress = structure
    ? { scenarios: computeScenarios(structure, snapshot, greeks, state.perpState, cfg) }
    : { scenarios: [] };

  // ── IV regime (Phase 3b): the entry signal, computed from the caller-attached IV history — the ring
  // lives in the MAIN process (snapshot.ivContext), never in this persisted state (O(1)-per-tick law).
  // LIVE settings, not the frozen engineCfg: entry advice must follow the CURRENT knobs even while an
  // old structure still runs — and the signal matters most while FLAT (structure == null).
  let iv_regime = null;
  if (snapshot.ivContext && Array.isArray(snapshot.ivContext.series)) {
    const liveCfg = buildCfg(state.settings);
    iv_regime = computeRegime(snapshot.ivContext.series, { nowMs, cfg: liveCfg });
    // The same ranking applied to the DVOL series: its history is backfilled 24–48h from the public
    // volatility-index endpoint, so this rank is meaningful from the first minutes of a session while
    // the ATM window is still filling. Context only — `favorable` stays ATM-driven.
    iv_regime.dvol_rank = computeRegime(
      snapshot.ivContext.series.map((e) => ({ ts: e.ts, atmIv: e.dvol })),
      { nowMs, cfg: liveCfg },
    ).iv_rank;
  }

  return {
    ts: snapshot.ts ?? nowMs,
    underlying_price: snapshot.underlying ?? null,
    index_price: snapshot.index ?? null,
    structure_id: structure?.id ?? null,
    option_legs,
    net_option_delta_bs: optionDelta,
    net_gamma: greeks.gamma,
    net_vega: greeks.vega,
    net_theta: greeks.theta,
    net_debit: structure?.entryDebitUsd ?? 0,
    current_net_value_usd: structure ? netDebit(structure, snapshot).debitUsd : 0,
    total_delta_bs: totalDelta,
    current_futures_delta: Qperp,
    perp_position,
    // Сверка с биржей идёт по НОМИНАЛУ: Deribit отдаёт дельту фьючерса в своей конвенции, и монитор
    // существует ровно затем, чтобы сойтись с её числом, а не с нашим (хеджем он не управляет).
    exchange_delta_total: exchangeDeltaTotal(structure, snapshot, mp.futuresNotionalBtc),
    target_futures_delta: decision.target_futures_delta,
    // ФАКТИЧЕСКАЯ полоса решения, а не настройка: она масштабируется размером структуры, и UI
    // объясняет Δ-триггер именно этим числом (index.html: «|Δ-избыток| ≤ дедбэнд»).
    hedge_deadband_btc: decision.deadband_btc ?? cfg.deadbandBtc,
    delta_excess: decision.delta_excess,
    price_move_since_last_hedge_pct: priceMovePct,
    trigger_reason: decision.trigger_reason,
    estimated_cost: decision.estimated_cost,
    estimated_benefit: decision.estimated_benefit,
    decision: decision.decision,
    hedge_order: decision.hedge_order,
    last_hedge: lastHedge,
    account: acct,
    pnl,
    hedge_vs,
    metrics: summarize(state.metrics),
    last_run_metrics: state.lastRunMetrics ?? null,
    stress,
    iv_regime,
    blackout: decision.blackout ?? { active: false, reason: null },
    gate: { ok: gateOk, reason: gateOk ? null : "greeks-missing" },
    payoff,
    fresh: snapshot.fresh ?? null,
  };
}

// ── Pre-trade check (Phase 3a): the structured go/no-go for opening THIS structure at THIS moment.
// Composes the pure structure checks (min lot / lot step / expiry coherence — "block"), the settlement
// blackout at the open moment ("block"; PDF p.14 "invalid due to … settlement state" — skipped when the
// user disabled the blackout), and the real Deribit IM vs paper equity ("warn" — user decision: surfaced
// with real numbers, opening still allowed; consistent with 2c's over_deposit honesty).
// `cfgOverride` несёт настройки схемы, отличные от профиля (сегодня это только схема продавца, см.
// `sellhedgeEngineCfg`). Проверка обязана судить по ТЕМ ЖЕ числам, по которым структура будет
// хеджиться после открытия: иначе блэкаут запретил бы открытие в окне, в котором сама схема
// блэкаута не имеет, и перевход после экспирации 08:00 UTC откладывался бы на десять минут.
export function preTradeCheck(state, structure, metaByInstrument, snapshot, nowMs, cfgOverride = null) {
  const cfg = { ...buildCfg(state.settings), ...(cfgOverride ?? {}) };
  const rejections = [...structureRejections(structure, metaByInstrument)];
  // Quote gate: every leg must have been priced by the snapshot the structure was built from — a
  // leg without a mark would open with entryMark null and silently DROP OUT of the net debit
  // (buildStructure sums entryMark ?? 0), understating cost/max-loss. Names every culprit; the
  // sweep surfaces this reason verbatim when a combo's wings aren't quoted in series[0].
  const unquoted = (structure.legs ?? []).filter((l) => !Number.isFinite(l.entryMark));
  if (unquoted.length)
    rejections.push({
      code: "no_quote",
      severity: "block",
      detail: `нет котировки (mark): ${unquoted.map((l) => l.instrument).join(", ")} — обновите данные и повторите`,
    });
  if (cfg.settlementBlackout !== false) {
    const b = settlementBlackout(nowMs, structure.expiryMs, cfg);
    if (b.active)
      rejections.push({
        code: "settlement",
        severity: "block",
        detail:
          b.reason === "pre-expiry"
            ? "<30 мин до экспирации — открытие в блэкаут запрещено"
            : "окно расчёта 08:00 UTC — открытие в блэкаут запрещено",
      });
  }
  const equity = (cfg.paperEquityUsd ?? 100) + attribute(state, snapshot).net_total;
  const im = structureMargin(structure, snapshot).initial;
  if (im > equity)
    rejections.push({
      code: "margin",
      severity: "warn",
      detail: `IM $${Math.round(im)} > депозит $${Math.round(equity)} — структура не помещается в депозит`,
    });
  return rejections;
}

// ── Open a structure (manual or auto). Auto-construction (Phase 3a): expiry == null ⇒ the engine picks
// the nearest live expiry itself (≤3d, skipping any already inside the pre-expiry blackout — opening into
// delta decay is never right). Gated by preTradeCheck; "warn" rejections ride along in the OK response.
export function openStructure(state, params, chain, snapshot, nowMs) {
  if (!state.sellChain) state.sellChain = { on: false, stopRequested: false, armedAt: null, stoppedAt: null, params: null, trades: [], mark: null, mode: "continuous", sanityWaitingSince: null };
  // One structure at a time: a second open would silently orphan the first (its MtM is realized only
  // via closeStructure) and leave the perp hedge sized for the discarded legs. The IPC resolve path is
  // async, so a double-click/retried invoke CAN land here twice — the guard, not the UI, is the invariant.
  if (state.structure) return { error: "структура уже открыта — сначала закройте текущую" };
  // ВЕТКА ПРОДАВЦА (params.kind === "sell-call"): контракт выбирает `pickSellLeg`, размер считает
  // `lotsByMargin` от ФАКТИЧЕСКОГО счёта; оба правила живут в sellhedge.js и здесь только зовутся.
  // Экспирация не подбирается и не передаётся: у этой схемы её выбирает окно срока внутри правила.
  // Дальше путь ОДИН на обе структуры (preTradeCheck, заморозка cfg, леджер, сброс метрик); второй
  // путь открытия означал бы второй набор предторговых проверок.
  let built;
  if (params?.kind === "sell-call") {
    // Окно ожидания санитарии: если ни одна нога не проходит дольше окна, открывается лучшая
    // доступная с постоянной пометкой «ухудшенная санитария» (§1.8: пометить лучше, чем
    // заблокировать - разрыв цепочки это единственная измеренно дорогая потеря).
    const allowDegraded = params.allowDegraded ?? shouldOpenDegraded({
      sanityWaitingSince: state.sellChain?.sanityWaitingSince ?? null,
      nowMs,
      windowMs: (params?.sanityCfg?.waitWindowH ?? SELL_SANITY_DEFAULTS.waitWindowH) * 3600000,
    });
    built = buildSellStructure(
      { ...params, allowDegraded, equityUsd: params.equityUsd ?? account(state, snapshot).equity },
      chain, snapshot, nowMs,
    );
  } else {
    if (params && params.expiry == null) {
      const cfg = buildCfg(state.settings);
      const exp = pickExpiry(chain, nowMs, { minLeadMs: (cfg.preExpirySec ?? 1800) * 1000 });
      if (exp == null) return { error: "нет живых экспираций ≤3д, авто-подбор невозможен" };
      params = { ...params, expiry: exp };
    }
    built = buildStructure(params, chain, snapshot);
  }
  if (built.error) {
    if (built.code === "sanity-none-passed") sellChainSanityWaitBegin(state, nowMs);
    return built;
  }
  if (built.kind === "sell-call") sellChainSanityWaitClear(state);

  // НАСТРОЙКИ СХЕМЫ ПРОДАВЦА приходят из её собственного модуля, а не из тулбара. Полоса, λ и
  // триггеры бота 2 калиброваны под четырёхногую структуру, и на этой схеме их дефолты стоят
  // половины результата (замер parity-sellhedge, 5 лет: ×24.2 против ×46.5). Разбор в шапке
  // `sellhedgeEngineCfg`. Патч применяется ДО предторговой проверки, потому что от него зависит и
  // она: блэкаут расчёта запрещает ОТКРЫТИЕ в окне 08:00 UTC, а экспирации Deribit наступают ровно
  // в 08:00 UTC, то есть при живом дефолте перевход упирался бы в собственный блэкаут.
  const sellEngineCfg =
    built.kind === "sell-call" ? sellhedgeEngineCfg({ ...SELLHEDGE_DEFAULTS, ...(params?.sellCfg ?? {}) }) : null;

  const metas = Array.isArray(chain) ? chain : chain?.instruments ?? [];
  const metaByInstrument = {};
  for (const l of built.legs) metaByInstrument[l.instrument] = metas.find((m) => m.instrument_name === l.instrument);
  const rejections = preTradeCheck(state, built, metaByInstrument, snapshot, nowMs, sellEngineCfg);
  const blocks = rejections.filter((r) => r.severity === "block");
  if (blocks.length) return { error: blocks.map((r) => r.detail).join("; "), rejections };

  built.id = `s1-${built.expiryMs}-${built.strikes.atm}-${nowMs}`;
  built.createdAt = nowMs;
  // Замер счётчиков ДО строки `open-cost`: издержки входа обязаны попасть в сделку, которая их
  // заплатила, а не раствориться между сделками цепочки.
  if (built.kind === "sell-call") {
    chainMarkOpen(state, nowMs);
    // Покрытие меряется за жизнь КОНКРЕТНОЙ сделки: перерыв, случившийся в прошлой, к решениям
    // хеджа этой отношения не имеет, а смешение двух окон дало бы среднее, не описывающее ни одно.
    state.sellChain.uptime = { ticks: 0, firstAt: nowMs, lastAt: null, maxGapMs: 0, gaps: [], nominalSec: state.settings?.repriceSec ?? 15 };
  }
  // Freeze the engine params at open (read-only while running). The ACTUAL open params (ticket
  // qty/offsets/execStyle) overlay the settings snapshot: the toolbar pushes settings through a
  // debounce, so a confirm racing a just-toggled control could otherwise freeze a stale value —
  // the position must hedge by what the ticket showed, not by what the settings file caught up to.
  const actualParams = Object.fromEntries(Object.entries(built.params).filter(([, v]) => v != null));
  // ПОРЯДОК СЛИЯНИЯ ЗНАЧИМ. Правила схемы продавца кладутся ПОСЛЕ параметров тикета и побеждают:
  // полоса, λ, триггеры и блэкаут у этой схемы не настройки оператора, а часть измеренного правила,
  // и собственного экрана у них нет. `execStyle` в патч НЕ входит специально: у него есть видимый
  // контрол в тулбаре, и молча переставлять его значило бы врать в интерфейсе. Цена такого выбора
  // названа числом: тейкерский хедж по 10 б.п. даёт ×1.16 против ×1.85 на четырёх годах.
  built.engineCfg = { ...state.settings, ...actualParams, ...(sellEngineCfg ?? {}) };
  state.structure = built;
  state.lastHedgeAt = null; // reset the hedge clock to structure open
  state.lastHedgeUnderlying = snapshot.underlying ?? null;
  state.metrics = initMetrics(); // run metrics scope to THIS structure's run (Phase 2b)
  appendLedger(state, {
    t: nowMs,
    type: "open",
    priceRef: snapshot.underlying ?? 0,
    note:
      built.kind === "sell-call"
        ? `продажа колла ${built.legs[0].instrument} · x${built.legs[0].qtyAbs}`
        : `winged straddle Kp${built.strikes.kp}/K${built.strikes.atm}/Kc${built.strikes.kc} · x${built.legs[0].qtyAbs}`,
  });
  // Издержки входа в опцион книжатся ОТДЕЛЬНОЙ строкой и сразу: они уплачены при пересечении книги, а
  // не при экспирации. Сумма идёт в realizedOptionsUsd (а не в feesCum перпа), поэтому ledgerReconciles
  // сходится: строки realizedUsd сверяются с СУММОЙ обоих накопителей, а feeUsd - только с перповым.
  if (Number.isFinite(built.entryCostUsd) && built.entryCostUsd !== 0) {
    state.realizedOptionsUsd = (state.realizedOptionsUsd || 0) - built.entryCostUsd;
    appendLedger(state, {
      t: nowMs,
      type: "open-cost",
      realizedUsd: -built.entryCostUsd,
      note: `издержки входа ${built.legs[0].instrument}: круг ${built.costs?.roundTripCostPct?.toFixed(3)}% премии, платится половина`,
    });
  }
  return { ok: true, structure: built, rejections };
}

// ── Flatten the perp hedge at market (immediacy over price — always order_type "market", so the
// taker rate applies regardless of the structure's execStyle). Shared by closeStructure and
// settleStructure so the two exit paths can never drift in math.
function flattenPerp(state, snapshot, nowMs, cfg) {
  const perp = snapshot.perp || null;
  if (state.perpState.qty === 0 || !perp || !perp.mark) return;
  // BTC ДЕЛЬТЫ, снимающие позицию в ноль. Считается от avgEntry, а не от марка: заявка выражена в
  // дельте, а дельта позиции равна qty·cs/avgEntry (см. markPerp). По марку получилось бы
  // qty·avgEntry/mark контрактов вместо qty, то есть «закрытие», оставляющее хвост позиции.
  const closeBtc = -markPerp(state.perpState, perp).futuresDeltaBtc;
  const side = closeBtc > 0 ? "buy" : "sell";
  const order = { side, amount_btc: Math.abs(closeBtc), amount_rounded_btc: Math.abs(closeBtc), order_type: "market", post_only: false };
  const priceRef = side === "buy" ? snapshot.liquidity?.ask ?? perp.mark : snapshot.liquidity?.bid ?? perp.mark;
  const fill = applyFill(state.perpState, order, priceRef, perp, cfg);
  appendLedger(state, { t: nowMs, type: "close-perp", side, contracts: fill.filledContracts, priceRef, feeUsd: fill.feeUsd, realizedUsd: fill.realizedUsd });
}

// ── ЦЕПОЧКА: ЗАМЕР НА ВХОДЕ И СТРОКА НА ВЫХОДЕ ─────────────────────────────────────────────────
//
// ИТОГ СДЕЛКИ СЧИТАЕТСЯ РАЗНОСТЬЮ НАКОПИТЕЛЕЙ, а не собственной арифметикой, и это принципиально:
// у бота 2 уже есть один ответ на вопрос «сколько заработано» (`attribute`), и второй ответ рядом
// с ним разошёлся бы с первым при первой же правке. Берутся ровно те четыре счётчика, из которых
// `attribute` складывает net_total, и в том же знаке:
//   net = опционы + перп + фандинг − комиссии.
// Замер снимается В САМОМ НАЧАЛЕ открытия, до строки `open-cost`, поэтому издержки входа попадают
// в сделку, которая их заплатила.
function chainCounters(state) {
  return {
    opt: state.realizedOptionsUsd || 0,
    perp: state.perpState.realizedUsd || 0,
    fund: state.perpState.fundingCum || 0,
    fees: state.perpState.feesCum || 0,
  };
}

function chainMarkOpen(state, nowMs) {
  state.sellChain.mark = { at: nowMs, ...chainCounters(state) };
}

// Дописать закрытую сделку. `reason` различает штатный выход и досрочный: схема измерена ТОЛЬКО с
// выходом в экспирацию, и сделка, закрытая руками, обязана нести это на себе постоянно, иначе итог
// цепочки молча смешает измеренное с неизмеренным.
function chainAppendTrade(state, nowMs, reason, settleSeq = null) {
  const st = state.structure;
  const m = state.sellChain?.mark;
  if (!st || st.kind !== "sell-call" || !m) return;
  const now = chainCounters(state);
  const pnl = now.opt - m.opt + (now.perp - m.perp) + (now.fund - m.fund) - (now.fees - m.fees);
  const leg = st.legs?.[0] ?? {};
  const im = st.sizing?.imUsedUsd ?? null;
  state.sellChain.trades.push({
    // Ссылка на строку `settle-options` своего расчёта: по ней поправка delivery-сверки находит
    // СВОЮ сделку (chainApplySettleAdjust). До прихода поправки итог предварительный: расчёт идёт
    // по индексу-прокси, а официальная delivery-цена публикуется позже.
    settleSeq,
    preliminary: reason === "expiry",
    instrument: leg.instrument ?? null,
    openedAt: st.createdAt ?? m.at,
    closedAt: nowMs,
    expiryMs: st.expiryMs ?? null,
    qtyAbs: leg.qtyAbs ?? null,
    lots: st.sizing?.lots ?? null,
    imUsd: im,
    premiumUsd: st.pickedLeg?.mark ?? null,
    strike: leg.strike ?? null,
    pnlUsd: pnl,
    // Доходность считается на ЗАЛОГ - та же база, в которой опубликован бектест («средняя +4.15%
    // залога»). Без залога процент не считается вовсе: подставлять вместо него премию или счёт
    // значило бы сравнивать с эталоном разные величины.
    retImPct: im > 0 ? (pnl / im) * 100 : null,
    fundingUsd: now.fund - m.fund,
    feesUsd: now.fees - m.fees,
    reason, // "expiry" | "manual"
    // Пометка «ухудшенная санитария» ПОСТОЯННА: сделка, открытая на непрошедшей проверке, обязана
    // нести это рядом со своим итогом, иначе итог цепочки молча смешает измеренное с неизмеренным.
    sanity: st.sanity ?? "ok",
  });
  state.sellChain.mark = null;
}

// ── Поправка delivery-сверки доезжает до СВОЕЙ сделки цепочки. Без этого прокси-итог сделки N
// оставался бы в строке навсегда, а поправка попадала бы в окно накопителей СЛЕДУЮЩЕЙ сделки
// (перевход идёт через ~30 секунд, delivery публикуется и сверяется минутами позже) либо, при
// плоском состоянии, ни в одну. Вызывающий обязан звать это В ТОМ ЖЕ месте, где книжит
// realizedOptionsUsd += adjustUsd: замер открытой сделки сдвигается на ту же величину, иначе
// чужая поправка попала бы в её окно. Строки, записанные до появления settleSeq, поправку в
// цепочку не принимают (некуда адресовать), глобальный учёт от этого не страдает.
export function chainApplySettleAdjust(state, srcSeq, adjustUsd) {
  const t = state.sellChain?.trades?.find((x) => x.settleSeq != null && x.settleSeq === srcSeq);
  if (t) {
    t.pnlUsd = (t.pnlUsd || 0) + adjustUsd;
    if (Number.isFinite(t.imUsd) && t.imUsd > 0) t.retImPct = (t.pnlUsd / t.imUsd) * 100;
    t.adjustUsd = (t.adjustUsd || 0) + adjustUsd;
    t.preliminary = false;
  }
  if (state.sellChain?.mark) state.sellChain.mark.opt += adjustUsd;
  return !!t;
}

// sellChainStats(state) - сводка цепочки. Чистая, считается из уже записанных сделок, нигде не
// хранится. `equityMult` перемножает (1 + доходность залога), как это делает эталон, поэтому число
// сравнимо с публикацией бектеста напрямую.
export function sellChainStats(state) {
  const trades = state.sellChain?.trades ?? [];
  const closed = trades.filter((t) => Number.isFinite(t.retImPct));
  const n = trades.length;
  if (!n) return { n: 0, wins: 0, winPct: null, avgRetPct: null, equityMult: null, maxDdPct: null,
    pnlUsd: 0, manual: 0, medianHoldD: null, perYear: null, firstAt: null, lastAt: null };
  let eq = 1, peak = 1, dd = 0;
  for (const t of closed) {
    eq *= 1 + t.retImPct / 100;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, (peak - eq) / peak);
  }
  const holds = trades.map((t) => (t.closedAt - t.openedAt) / 86400000).filter((x) => x > 0).sort((a, b) => a - b);
  const medianHoldD = holds.length ? holds[(holds.length - 1) >> 1] : null;
  return {
    n,
    wins: trades.filter((t) => t.pnlUsd > 0).length,
    winPct: (trades.filter((t) => t.pnlUsd > 0).length / n) * 100,
    avgRetPct: closed.length ? closed.reduce((s, t) => s + t.retImPct, 0) / closed.length : null,
    equityMult: closed.length ? eq : null,
    maxDdPct: closed.length ? dd * 100 : null,
    pnlUsd: trades.reduce((s, t) => s + t.pnlUsd, 0),
    manual: trades.filter((t) => t.reason === "manual").length,
    medianHoldD,
    // Ожидание сделок за год берётся из ФАКТИЧЕСКОГО срока удержания, а не из константы 17: срок
    // зависит от того, какие экспирации листингованы, и врать тут нечем.
    perYear: medianHoldD > 0 ? 365 / medianHoldD : null,
    firstAt: trades[0].openedAt,
    lastAt: trades[n - 1].closedAt,
  };
}

// Freeze the finished run's metrics BEFORE the structure ref is dropped — openStructure wipes
// state.metrics at the next open, so this snapshot is the only survivor of a completed run.
function snapshotRunMetrics(state, nowMs) {
  return {
    structureId: state.structure?.id ?? null,
    openedAt: state.structure?.createdAt ?? null,
    closedAt: nowMs,
    ...summarize(state.metrics),
  };
}

// ── Close the structure: flatten the perp (realize inverse P&L), lock in the option MtM, keep the
// cumulative P&L (realizedOptionsUsd survives, so net P&L is not reset by closing).
export function closeStructure(state, snapshot, nowMs) {
  if (!state.structure) return { error: "нет открытой структуры" };
  // A held perp needs a PRICED perp to flatten. Without this guard flattenPerp silently no-ops,
  // the options still close and structure goes null — orphaning an unclosable hedge position
  // (the close button hides with the structure) that keeps accruing funding. Same perpPriced
  // rule settleStructure applies: closing late beats closing wrong.
  if (state.perpState.qty !== 0 && !(snapshot?.perp && snapshot.perp.mark)) {
    return { error: "нет цены перпетуала в снимке — обновите данные и повторите закрытие" };
  }
  const cfg = buildCfg(state.settings);
  flattenPerp(state, snapshot, nowMs, cfg);

  const optMtm = markStructure(state.structure, snapshot).upl_usd;
  state.realizedOptionsUsd = (state.realizedOptionsUsd || 0) + optMtm;
  appendLedger(state, { t: nowMs, type: "close-options", realizedUsd: optMtm, note: `closed ${state.structure.id}` });

  state.lastRunMetrics = snapshotRunMetrics(state, nowMs);
  // ДОСРОЧНЫЙ выход помечается навсегда: схема измерена только с выходом в экспирацию, и цепочка,
  // содержащая ручное закрытие, обязана говорить об этом рядом со своим итогом.
  chainAppendTrade(state, nowMs, "manual");
  state.structure = null;
  state.lastHedgeAt = null;
  state.lastHedgeUnderlying = null;
  return { ok: true };
}

// ── Expiry settlement: a structure that reaches its expiry cash-settles instead of freezing. Without
// this the legs vanish from the API, the greeks gate fails forever and markStructure falls back to
// entry marks — i.e. the UI would show a phantom ≈0 MtM instead of the real terminal payoff.
// Settlement price S = snapshot.index (perp index once the option tickers are gone) — an honest PROXY
// of Deribit's real delivery price (the 30-min index TWAP before 08:00 UTC), noted in the ledger row.
// Options settle at intrinsic value: the realized amount is exactly payoffAt(structure, S) — the same
// terminal "tent" the payoff chart promises. A degraded tick (no finite index, or an unpriced perp
// while a hedge is still held) does NOT settle — settling on garbage is worse than settling late; the
// next priced tick picks it up. A LATE settle (app was closed over the expiry) uses the then-current
// index and says so in the note.
export function settleStructure(state, snapshot, nowMs) {
  const structure = state.structure;
  if (!structure || !(nowMs >= structure.expiryMs)) return { settled: false };
  const S = snapshot.index ?? snapshot.underlying;
  const perpPriced = state.perpState.qty === 0 || (snapshot.perp && snapshot.perp.mark);
  if (!Number.isFinite(S) || !perpPriced) return { settled: false };

  const cfg = buildCfg(state.settings);
  flattenPerp(state, snapshot, nowMs, cfg);

  const optSettleUsd = payoffAt(structure, S);
  state.realizedOptionsUsd = (state.realizedOptionsUsd || 0) + optSettleUsd;
  const lateH = Math.floor((nowMs - structure.expiryMs) / 3600000);
  appendLedger(state, {
    t: nowMs,
    type: "settle-options",
    priceRef: S,
    realizedUsd: optSettleUsd,
    // meta feeds the delivery-price reconcile (pnl.planSettleAdjustments): unit = legs[0]
    // qtyAbs·contractSize — the same per-unit scale payoff.js derives (equal-qty legs law).
    // НОГИ ЗАПИСЫВАЮТСЯ ЯВНО, и это не дубль strikes. Пересчёт по одним страйкам умеет только тент:
    // структуре из одной проданной ноги формула тента молча вернула бы |S−K| (модуль страйка вместо
    // короткого колла), то есть НЕВЕРНУЮ поправку, а не ошибку. Список ног задаёт геометрию любой
    // структуры однозначно; strikes остаётся для строк, записанных до этой правки.
    meta: {
      expiryMs: structure.expiryMs,
      strikes: structure.strikes,
      unit: (structure.legs[0]?.qtyAbs ?? 1) * (structure.legs[0]?.contractSize ?? 1),
      legs: (structure.legs ?? []).map((l) => ({
        type: l.type, strike: l.strike, qtyAbs: l.qtyAbs, qtySigned: l.qtySigned, contractSize: l.contractSize,
      })),
    },
    note:
      `экспирация ${structure.id} · расчёт по индексу (прокси delivery-цены Deribit)` +
      (lateH >= 1 ? ` · поздний расчёт +${lateH}ч (приложение не работало в момент экспирации)` : ""),
  });

  state.lastRunMetrics = snapshotRunMetrics(state, nowMs);
  const settleSeq = state.ledger[state.ledger.length - 1]?.seq ?? null;
  chainAppendTrade(state, nowMs, "expiry", settleSeq); // ШТАТНЫЙ выход схемы, единственный измеренный
  state.structure = null;
  state.lastHedgeAt = null;
  state.lastHedgeUnderlying = null;
  return { settled: true, priceRef: S, realizedUsd: optSettleUsd };
}

// ── Paper account estimate. Equity = deposit + cumulative net P&L. Margin (Phase 2c) is the REAL Deribit
// Standard-Margin requirement of the SHORT option legs (linear/USDC formulas, per-leg sum, no netting) —
// replacing the Phase-1 debit proxy. On tiny size vs a $100 deposit the min-size straddle's initial margin
// can EXCEED the deposit; that is surfaced honestly (over_deposit + the utilisation figures), not gated.
// margin_alert keys on MAINTENANCE utilisation (the liquidation-relevant figure), not initial.
export function account(state, snapshot) {
  const cfg = buildCfg(state.settings);
  const pnl = attribute(state, snapshot);
  const equity = (cfg.paperEquityUsd ?? 100) + pnl.net_total;
  const m = state.structure ? structureMargin(state.structure, snapshot) : { initial: 0, maintenance: 0 };
  const denom = Math.max(1e-9, equity);
  const initial_utilisation = m.initial / denom;
  const maintenance_utilisation = m.maintenance / denom;
  return {
    equity,
    margin_balance: equity,
    initial_margin: m.initial,
    maintenance_margin: m.maintenance,
    initial_utilisation,
    maintenance_utilisation,
    worst_utilisation: Math.max(maintenance_utilisation, state.metrics?.worstMaintUtil ?? 0),
    over_deposit: m.initial > equity,
    margin_alert: maintenance_utilisation >= (cfg.marginAlertPct ?? 0.8),
  };
}
