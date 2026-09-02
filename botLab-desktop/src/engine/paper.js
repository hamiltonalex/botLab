// paper.js - forward paper-trading funding/borrow accrual engine. It prices the modeled carry from
// real exchange rates; execution effects, liquidation and account reconciliation remain outside
// this Phase-1 ledger and must not be inferred from its P&L.
//
//   * GMX funding + borrow accrue CONTINUOUSLY: dPnl = factorPerSec * elapsedSeconds * notional.
//   * HL funding settles DISCRETELY at the top of each hour: a held position pays/receives
//     hl_rate * notional once per crossed hour boundary (close mid-hour => that hour not charged).
//   * Round-trip fees (open+close) are modeled once and netted against gross funding P&L.
//
// No orders, no keys - this simulates the ledger a real position WOULD produce from live rates.
//
// ЦЕНА ОТСУТСТВУЮЩЕЙ ЛИКВИДАЦИИ ИЗМЕРЕНА, И ОНА НЕ МАЛА. Английская оговорка выше говорит, что
// ликвидации в этом леджере НЕТ; она не говорит, сколько это стоит, и потому читается как мелочь.
// Замер 2026-08-31 (ветка исследования, `scripts/funding-arb-study/pf-vf-залог.mjs`):
//
//   Ноги стоят на РАЗНЫХ биржах, кросс-маржи между GMX и Hyperliquid нет, поэтому прибыль
//   уцелевшей ноги проигрывающую НЕ ПОДДЕРЖИВАЕТ. Позиция дельта-нейтральна в сумме и при этом
//   ликвидируема поштучно.
//
//   BERA, февраль 2026: цена прошла +127.59% за отрезок удержания (768-792 ч). Короткая нога
//   умирает при ходе около +95%, то есть ДАЖЕ ПРИ ПЛЕЧЕ 1. Дальше цена откатила, и к концу
//   отрезка осталось +18.9%: выбитая нога потеряна целиком, уцелевшая отдала бумажную прибыль.
//   Депозит $3991 стал $2373, то есть минус 41%, что равно 2.30 ГОДА чистого дохода стратегии.
//
//   Частота: 2 отрезка из 132 при плече 1 (оба это ОДИН календарный эпизод, увиденный с двух
//   сдвигов старта), 10 из 132 при плече 2, 46 из 132 при плече 3.
//
// СЛЕДСТВИЕ ДЛЯ ЧТЕНИЯ ЛЮБОГО ЧИСЛА ЭТОГО ЛЕДЖЕРА: просадка и доходность, посчитанные здесь, это
// просадка и доходность КРИВОЙ ФИНАНСИРОВАНИЯ, и они по построению НЕ содержат того риска, который
// решает дело. Число «худшая просадка 0.69% депозита» верно и неполно одновременно.
//
// ЧТО ЭТО ЗНАЧИТ ДЛЯ АВТОМАТА (фаза 4): сторож залога обеих ног это блокирующий компонент, а не
// украшение. Автомат обязан брать `liquidationPx` каждой ноги на каждом опросе и отказывать и во
// входе, и в удержании при недостаточном запасе, называя отказ вслух.
//
// РАЗБАВЛЕНИЕ ВХОДА (позиции с `dilute: true`). Котируемая ставка это ставка рынка БЕЗ нас. Наш
// вход увеличивает базу принимающей стороны, и достаётся нам `f * B/(B+S)`, а не `f`. Правило
// целиком живёт в `fa/dilution.js` и зовётся ПОЧАСОВО на каждом начислении обеих веток (живой и
// исторической); здесь только подстановка размера позиции и базы нашей стороны. Позиция без флага
// считается ровно теми же выражениями в том же порядке, что и до появления правила, поэтому её
// числа не двигаются даже в последнем разряде.

import { SEC_PER_HOUR, HOURS_PER_YEAR } from "./math.js";
import { NO_DILUTION, dilutedFundingRate, isFlowHour, resolveBase } from "./fa/dilution.js";

const HOUR_MS = SEC_PER_HOUR * 1000;
let idCounter = 0;

// Per-second GMX net factor and per-hour HL settlement sign for a given strategy/config.
export function legModel(strategy, config) {
  // Одна нога: короткая на GMX с залогом в том же активе. Ноги Hyperliquid нет, и ценового
  // результата леджер по ней не книжит НАМЕРЕННО: при плече 1 залог дорожает ровно на ход против
  // шорта, позиция нейтральна к цене в долларах, и её результат это фандинг минус заимствование
  // короткой стороны (шапка `universe.js`).
  if (strategy === "one") return { gmxSide: "short", hlPerHourSign: 0 };
  return config === "A"
    ? { gmxSide: "short", hlPerHourSign: -1 } // A: short GMX (recv funding, pay borrow) + long HL (pays +hl_rate)
    : { gmxSide: "long", hlPerHourSign: +1 }; // B: long GMX + short HL (receives +hl_rate)
}

function gmxNetPerSec(snap, gmxSide) {
  return gmxSide === "short" ? snap.f_short - snap.b_short : snap.f_long - snap.b_long;
}

// Разбавление ставки нашей ноги собственным входом. Размер это НОЦИОНАЛ позиции, а не капитал:
// в базу фандинга GMX входит размер позиции, и при плече отличном от единицы капитал дал бы
// множитель тем ближе к единице, чем выше плечо, то есть тем меньше разбавления, чем больше мы
// на самом деле давим на рынок.
function accrualDilution(position, rowOrSnapshot, gmxSide) {
  if (!position.dilute) return NO_DILUTION;
  const f = gmxSide === "short" ? rowOrSnapshot.f_short : rowOrSnapshot.f_long;
  return dilutedFundingRate(f, resolveBase(rowOrSnapshot, gmxSide), position.notional);
}

// Поля разбавления в журнале начисления. Пишутся ТОЛЬКО у разбавляемых позиций: у остальных запись
// обязана остаться той же, что и раньше, и лишние три поля на каждый час начисления это ещё и
// впустую занятый диск (позиция живёт месяцами, начисление ежечасное).
function dilutionEntry(dil, fundingQuotedUsd) {
  if (dil.reason === "off") return null;
  return { fundingQuotedUsd, dilutionFactor: dil.factor, dilutionReason: dil.reason };
}

// Create a new paper position at t0. `costs` is the resolved round-trip cost in $ (see costs.js).
// costBreakdown/openMarkPx are optional t0 snapshots for the transaction ledger: the cost model is
// user-editable and live prices move on, so both must be frozen at open or not shown at all.
// `dilute` включает эмуляцию РЕАЛЬНОГО входа (см. шапку). Флаг явный, а не «включиться самому при
// наличии баз в данных»: иначе пропажа баз молча вернула бы завышенную прибыль, то есть дефект
// чинился бы ровно до первого сбоя снабжения.
export function openPosition({ strategy, instrumentKey, config = null, capital, leverage, nowMs, meta = {}, roundTripCost = 0, costBreakdown = null, openMarkPx = null, dilute = false }) {
  const notional = capital * leverage;
  const t0 = nowMs;
  return {
    id: `p${++idCounter}_${t0}`,
    createdAt: t0,
    strategy, // 'two' | 'one'
    instrumentKey, // e.g. 'ETH' or 'ETH-Avax'
    config: strategy === "two" ? config : null,
    capital,
    leverage,
    notional,
    roundTripCost,
    costBreakdown,
    openMarkPx,
    dilute: dilute === true,
    meta, // { gmxName, hlCoin, chain, token, ... } for display + snapshot lookup
    status: "open",
    closedAt: null,
    lastAccrualAt: t0,
    cumFunding: 0, // gross cumulative $ from funding/borrow
    peakCum: 0,
    maxDrawdown: 0, // most-negative (cum - peak), <= 0
    equityCurve: [{ t: t0, cum: 0, equityGross: capital, equityNet: capital - roundTripCost }],
    accruals: [], // audit ledger of each accrual step
  };
}

// Shared: apply one signed P&L delta to the running position state and emit ledger/curve points.
function applyDelta(position, nowMs, entry) {
  position.cumFunding += entry.dPnl;
  if (position.cumFunding > position.peakCum) position.peakCum = position.cumFunding;
  const dd = position.cumFunding - position.peakCum;
  if (dd < position.maxDrawdown) position.maxDrawdown = dd;
  position.lastAccrualAt = nowMs;
  const point = {
    t: nowMs,
    cum: position.cumFunding,
    equityGross: position.capital + position.cumFunding,
    equityNet: position.capital + position.cumFunding - position.roundTripCost,
  };
  position.equityCurve.push(point);
  position.accruals.push({ t: nowMs, cum: position.cumFunding, ...entry });
  return point;
}

// Accrue one interval from position.lastAccrualAt -> nowMs using the current live snapshot.
// snapshot = canonical current factors { f_long, f_short, b_long, b_short, hl_rate } for the instrument.
// opts.maxDtSec caps how far back a single live-rate step may reach: pricing a long offline gap at
// the CURRENT instantaneous rate is wrong (gaps must be backfilled from history via accrueFromRows);
// anything beyond the cap is recorded as gapSkippedSec in the ledger instead of being mispriced.
// Returns the new equity point, or null if the snapshot is invalid (interval is carried forward).
export function accrue(position, snapshot, nowMs, opts = {}) {
  if (position.status !== "open") return null;
  if (nowMs <= position.lastAccrualAt) return null;
  const { f_long, f_short, b_long, b_short, hl_rate } = snapshot || {};
  const needed = position.strategy === "one" ? [f_short, b_short] : [f_long, f_short, b_long, b_short, hl_rate];
  if (needed.some((x) => !Number.isFinite(x))) return null; // don't advance time on bad data

  const { gmxSide, hlPerHourSign } = legModel(position.strategy, position.config);
  let dtSec = (nowMs - position.lastAccrualAt) / 1000;
  let gapSkippedSec = 0;
  let accrueFromMs = position.lastAccrualAt;
  const maxDtSec = Number.isFinite(opts.maxDtSec) ? opts.maxDtSec : Infinity;
  if (dtSec > maxDtSec) {
    gapSkippedSec = dtSec - maxDtSec;
    dtSec = maxDtSec;
    accrueFromMs = nowMs - maxDtSec * 1000;
  }

  // GMX: continuous accrual over elapsed seconds.
  const gmxPerSec = gmxNetPerSec(snapshot, gmxSide);
  const dPnlGmxQuoted = gmxPerSec * dtSec * position.notional;
  // Ledger split: funding priced from its own factor; borrow as the EXACT complement of the QUOTED
  // funding, so the pair sums to the dPnlGmx every existing consumer/test asserts on.
  const fundingQuotedUsd = (gmxSide === "short" ? f_short : f_long) * dtSec * position.notional;
  // Борроу считается от КОТИРУЕМОГО фандинга и разбавлением не трогается (правило 2): наш вход
  // меняет то, сколько нам платят, и не меняет того, сколько мы платим за заёмную ликвидность.
  const borrowUsd = dPnlGmxQuoted - fundingQuotedUsd;
  const dil = accrualDilution(position, snapshot, gmxSide);
  // При factor === 1 (разбавление выключено, платим мы, нулевой размер) исполняются те же
  // выражения в том же порядке, что и до появления правила. Пересобрать сумму «эквивалентно», как
  // fundingUsd + borrowUsd, было бы нельзя: (f-b)*dt*N и f*dt*N + (-b)*dt*N дают разный последний
  // бит, и три замороженные книги охраны перестали бы совпадать побайтово.
  const fundingUsd = dil.factor === 1 ? fundingQuotedUsd : dil.rate * dtSec * position.notional;
  const dPnlGmx = dil.factor === 1 ? dPnlGmxQuoted : fundingUsd + borrowUsd;

  // HL: one discrete settlement per crossed top-of-hour boundary, using the current rate estimate.
  let hlSettlements = 0;
  if (hlPerHourSign !== 0 && Number.isFinite(hl_rate)) {
    const fromHour = Math.floor(accrueFromMs / HOUR_MS);
    const toHour = Math.floor(nowMs / HOUR_MS);
    hlSettlements = Math.max(0, toHour - fromHour);
  }
  const dPnlHl = hlSettlements * hlPerHourSign * (hl_rate || 0) * position.notional;

  return applyDelta(position, nowMs, {
    source: "live",
    dtSec,
    gapSkippedSec,
    gmxPerSec,
    dPnlGmx,
    fundingUsd,
    borrowUsd,
    hlSettlements,
    dPnlHl,
    dPnl: dPnlGmx + dPnlHl,
    markPx: Number.isFinite(opts.markPx) ? opts.markPx : null, // best-effort mark at accrual time
    ...dilutionEntry(dil, fundingQuotedUsd),
  });
}

// Accrue an offline gap from HISTORICAL hourly rows (canonical frame rows: tsHour in epoch seconds,
// f_long/f_short/b_long/b_short per-second factors, hl_rate hourly). Each hour is priced at ITS OWN
// recorded rates: GMX continuously over the overlapped seconds, HL as one settlement per fully
// crossed top-of-hour boundary. Advances lastAccrualAt hour by hour; the remainder (beyond the last
// available row) is left for the live accrue(). Returns a summary of what was applied.
export function accrueFromRows(position, rows, nowMs) {
  if (position.status !== "open" || !rows || !rows.length) return { hoursApplied: 0, gapSkippedSec: 0 };
  const { gmxSide, hlPerHourSign } = legModel(position.strategy, position.config);
  let hoursApplied = 0;
  let gapSkippedSec = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.tsHour)) continue;
    const hourStartMs = r.tsHour * 1000;
    const hourEndMs = hourStartMs + HOUR_MS;
    if (hourEndMs <= position.lastAccrualAt) continue; // already accrued
    const start = Math.max(position.lastAccrualAt, hourStartMs);
    const end = Math.min(hourEndMs, nowMs);
    if (end <= start) continue;
    const needed = position.strategy === "one" ? [r.f_short, r.b_short] : [r.f_long, r.f_short, r.b_long, r.b_short, r.hl_rate];
    if (needed.some((x) => !Number.isFinite(x))) continue; // hole in history: skip this hour
    // If an earlier row was missing/invalid, advancing into this valid hour permanently closes that
    // interval. Record it on the ledger instead of silently losing it from the account summary.
    const uncoveredSec = Math.max(0, (start - position.lastAccrualAt) / 1000);
    gapSkippedSec += uncoveredSec;
    const dtSec = (end - start) / 1000;
    const gmxPerSec = gmxNetPerSec(r, gmxSide);
    const dPnlGmxQuoted = gmxPerSec * dtSec * position.notional;
    // Ledger split (see accrue): borrow is the exact complement of the funding part.
    const fundingQuotedUsd = (gmxSide === "short" ? r.f_short : r.f_long) * dtSec * position.notional;
    const borrowUsd = dPnlGmxQuoted - fundingQuotedUsd;
    // Разбавление берётся из базы ЭТОГО часа: правило почасовое, и среднего множителя по окну здесь
    // не существует нигде. Деньги сидят в часах с самой малой базой, то есть с наибольшим весом,
    // и усреднение множителя завышало доход именно там, где он весь и находится.
    const dil = accrualDilution(position, r, gmxSide);
    const fundingUsd = dil.factor === 1 ? fundingQuotedUsd : dil.rate * dtSec * position.notional;
    const dPnlGmx = dil.factor === 1 ? dPnlGmxQuoted : fundingUsd + borrowUsd;
    // The hour's settlement lands on its closing boundary; count it only if we crossed it.
    const hlSettlements = hlPerHourSign !== 0 && end === hourEndMs ? 1 : 0;
    const dPnlHl = hlSettlements * hlPerHourSign * (r.hl_rate || 0) * position.notional;
    applyDelta(position, end, {
      source: "history",
      dtSec,
      gapSkippedSec: uncoveredSec,
      gmxPerSec,
      dPnlGmx,
      fundingUsd,
      borrowUsd,
      hlSettlements,
      dPnlHl,
      dPnl: dPnlGmx + dPnlHl,
      ...dilutionEntry(dil, fundingQuotedUsd),
    });
    hoursApplied++;
    if (end >= nowMs) break;
  }
  return { hoursApplied, gapSkippedSec };
}

// Settle a position up to nowMs with a bounded live step. If the elapsed gap exceeds capSec, the
// whole-hour part of the gap is priced from HISTORICAL rows first (each hour at its own recorded
// rates); only the remainder is priced at the current live snapshot, still capped by capSec.
// This keeps EVERY accrual path (poll tick, poll-interval change, close) free of the cap dead
// zone: a gap the live step can't cover is silently dropped ONLY when no history exists for it.
// Without this, shrinking the poll interval mid-session (15m -> 1m) or a laptop sleep/wake shrank
// or outgrew the live cap and lost real funding (incl. HL top-of-hour settlements) to
// gapSkippedSec until the next full restart (gap backfill used to be boot-only).
export function settlePosition(position, rows, snapshotRaw, nowMs, capSec, opts = {}) {
  if (position.status !== "open") return false;
  let changed = false;
  const gapSec = (nowMs - position.lastAccrualAt) / 1000;
  if (Number.isFinite(capSec) && gapSec > capSec && rows && rows.length) {
    if (accrueFromRows(position, rows, nowMs).hoursApplied > 0) changed = true;
  }
  if (snapshotRaw && accrue(position, snapshotRaw, nowMs, { maxDtSec: capSec, markPx: opts.markPx })) changed = true;
  return changed;
}

// Explicitly close an interval that cannot be priced from either history or a valid live snapshot.
// Advancing with a zero delta is acceptable only when the missing duration is recorded: callers
// (notably closePaper) can remain operable during an outage without silently erasing ledger time.
export function recordUnpricedGap(position, nowMs, reason = "required live data unavailable") {
  if (position.status !== "open" || nowMs <= position.lastAccrualAt) return null;
  const gapSkippedSec = (nowMs - position.lastAccrualAt) / 1000;
  return applyDelta(position, nowMs, {
    source: "skipped",
    reason,
    dtSec: 0,
    gapSkippedSec,
    gmxPerSec: 0,
    dPnlGmx: 0,
    hlSettlements: 0,
    dPnlHl: 0,
    dPnl: 0,
  });
}

export function closePosition(position, nowMs) {
  if (position.status === "open") {
    position.status = "closed";
    position.closedAt = nowMs;
  }
  return position;
}

// Annualization is meaningless below this horizon (it just multiplies noise/one-off costs by
// 8760/hours); the UI shows "-" until enough hours have accrued.
export const APR_MIN_HOURS = 24;

// Realized summary (used by the hero + forward equity panel).
export function positionSummary(position) {
  const grossPnl = position.cumFunding;
  const netPnl = grossPnl - position.roundTripCost;
  const hoursElapsed = (position.lastAccrualAt - position.createdAt) / HOUR_MS;
  const ret = position.capital ? netPnl / position.capital : 0;
  // aprGross annualizes ONLY the funding flow (a rate, meaningful to annualize); apr additionally
  // amortizes the one-off round-trip cost - reliable only once enough hours have passed.
  const aprGross = hoursElapsed > 0 ? (grossPnl / position.capital) * (HOURS_PER_YEAR / hoursElapsed) : 0;
  const apr = hoursElapsed > 0 ? (netPnl / position.capital) * (HOURS_PER_YEAR / hoursElapsed) : 0;
  // Один проход по журналу: пропущенное время и честность ставки. Порядок сложения тот же, что был
  // у reduce, иначе плавающая точка дала бы другой последний разряд у уже застывших книг.
  let gapSkippedSec = 0;
  // ПОТОК это часы, когда фандинг ПОЛУЧАЕМ мы, и только они. Часы собственной уплаты в обе суммы
  // входить не имеют права: разбавление их не трогает (правило 3), значит они добавляют одно и то
  // же отрицательное число и в числитель, и в знаменатель. На APT конфигурации B это давало долю
  // удержания -283.5%, то есть число, которое ничего не измеряет. Разница сумм при этом не
  // страдает: в часы уплаты она ровно ноль, и цена фантома одинакова при обоих способах счёта.
  let flowQuoted = 0; // сколько обещала КОТИРУЕМАЯ ставка в часы получения
  let flowReceived = 0; // сколько досталось после разбавления собственным входом
  let noBaseSec = 0; // время, где базы не было вовсе и доход обнулён (издержки ноги остались)
  let badBaseSec = 0; // время, где база пришла не та (тождество не сошлось) и доход обнулён
  for (const a of position.accruals || []) {
    gapSkippedSec += a.gapSkippedSec || 0;
    if (!isFlowHour(a.dilutionReason)) continue;
    flowQuoted += a.fundingQuotedUsd || 0;
    flowReceived += a.fundingUsd || 0;
    if (a.dilutionReason === "no_base") noBaseSec += a.dtSec || 0;
    if (a.dilutionReason === "base_identity_broken") badBaseSec += a.dtSec || 0;
  }
  // Доля удержания это ГЛАВНОЕ число карточки честности: при $2000 на рынок рынок отдаёт около
  // 8.8% котируемого потока, при $10 000 уже 6.3%. У позиции без разбавления числа нет вовсе, и
  // показывать вместо него 100% нельзя: это ровно тот фантом, ради которого правило и заведено.
  const dilutionRetained = flowQuoted > 0 ? flowReceived / flowQuoted : null;
  return {
    grossPnl,
    netPnl,
    roundTripCost: position.roundTripCost,
    equityGross: position.capital + grossPnl,
    equityNet: position.capital + netPnl,
    ret,
    apr,
    aprGross,
    aprReliable: hoursElapsed >= APR_MIN_HOURS,
    hoursElapsed,
    gapSkippedSec, // seconds of history that could NOT be priced (no data) - honesty marker
    flowQuoted, // 0 у позиции без разбавления; разница с flowReceived это цена фантома
    flowReceived,
    dilutionRetained, // null у позиции без разбавления
    noBaseSec,
    badBaseSec,
    maxDrawdown: position.maxDrawdown, // $, <= 0
    // drawdown as a fraction of NOTIONAL (the base the excursion actually scales with); the UI
    // multiplies by leverage when a capital-relative % is wanted. (audit: was /capital, leverage-inflated)
    maxDrawdownPct: position.notional ? Math.abs(position.maxDrawdown) / position.notional : 0,
  };
}

// Portfolio max drawdown ($, <= 0) on the COMBINED equity curve across positions - NOT the sum of
// per-position drawdowns (troughs at different times must not be added; maxDD is not additive).
// Each position contributes its running cumulative funding (cum); pointers advance independently by
// time, so a position that has not opened yet contributes 0 and a closed one holds its final cum.
export function combinedMaxDrawdown(positions) {
  const active = (positions || []).filter((p) => p.equityCurve && p.equityCurve.length);
  if (!active.length) return 0;
  const ptr = active.map(() => 0);
  const cum = active.map(() => 0);
  const times = [...new Set(active.flatMap((p) => p.equityCurve.map((pt) => pt.t)))].sort((a, b) => a - b);
  let peak = 0;
  let worst = 0;
  for (const t of times) {
    let total = 0;
    for (let i = 0; i < active.length; i++) {
      const ec = active[i].equityCurve;
      while (ptr[i] < ec.length && ec[ptr[i]].t <= t) cum[i] = ec[ptr[i]++].cum;
      total += cum[i];
    }
    if (total > peak) peak = total;
    const dd = total - peak;
    if (dd < worst) worst = dd;
  }
  return worst;
}

// Account roll-up across all paper positions (open + closed). Annualizes over the ACTUAL accrual
// horizon (first createdAt -> last accrual across positions), NOT wall-clock now - so realized APR
// and $/hr stay frozen after positions close instead of decaying to zero. Drawdown is the
// combined-curve drawdown; notionalAll exposes leveraged per-leg notional for the UI. Returns null
// for an empty account.
export function accountSummary(positions) {
  const ps = positions || [];
  if (!ps.length) return null;
  let netPnl = 0;
  let grossPnl = 0;
  let capitalAll = 0;
  let notionalAll = 0;
  let gapSkippedSec = 0;
  let flowQuoted = 0;
  let flowReceived = 0;
  let noBaseSec = 0;
  let badBaseSec = 0;
  let firstT0 = Infinity;
  let lastT = 0;
  let open = 0;
  for (const p of ps) {
    const s = positionSummary(p);
    netPnl += s.netPnl;
    grossPnl += s.grossPnl;
    capitalAll += p.capital;
    notionalAll += p.notional;
    gapSkippedSec += s.gapSkippedSec;
    flowQuoted += s.flowQuoted;
    flowReceived += s.flowReceived;
    noBaseSec += s.noBaseSec;
    badBaseSec += s.badBaseSec;
    firstT0 = Math.min(firstT0, p.createdAt);
    lastT = Math.max(lastT, p.lastAccrualAt || p.createdAt);
    if (p.status === "open") open++;
  }
  const hoursSinceFirst = (Math.max(lastT, firstT0) - firstT0) / HOUR_MS;
  const ret = capitalAll ? netPnl / capitalAll : 0;
  const apr = capitalAll && hoursSinceFirst > 0 ? ret * (HOURS_PER_YEAR / hoursSinceFirst) : 0;
  const aprGross = capitalAll && hoursSinceFirst > 0 ? (grossPnl / capitalAll) * (HOURS_PER_YEAR / hoursSinceFirst) : 0;
  return {
    count: ps.length,
    open,
    closed: ps.length - open,
    netPnl,
    grossPnl,
    capitalAll,
    notionalAll,
    ret,
    apr,
    aprGross,
    aprReliable: hoursSinceFirst >= APR_MIN_HOURS,
    hoursSinceFirst,
    firstT0,
    maxDrawdown: combinedMaxDrawdown(ps),
    gapSkippedSec,
    flowQuoted,
    flowReceived,
    // Доля удержания по счёту считается от СУММ, а не средним по позициям: позиции разного размера
    // и на разных рынках, и среднее долей дало бы вес мелкому рынку наравне с крупным.
    dilutionRetained: flowQuoted > 0 ? flowReceived / flowQuoted : null,
    noBaseSec,
    badBaseSec,
  };
}
