// structure.js — «BTC-опционы» (Strategy One) 4-leg winged-straddle STRUCTURE builder + net-greek/debit
// aggregators + pre-trade gates (pickExpiry / structureRejections). PURE: no fetch / fs / DOM / Date.now —
// time comes in as nowMs, so everything is deterministic and unit-testable. The structure is the paper
// position (long ATM call + long ATM put − short OTM call − short OTM put); market greeks come FROM the
// composite snapshot (Deribit), never priced here. engine.js later stamps id/createdAt — NOT here.

import { legMargin } from "./margin.js";
import { computeTradeCosts } from "../otmscan/economics.js";
import { SELLHEDGE_DEFAULTS, pickSellLeg, lotsByMargin, halfSpreadUsd, openSellTrade } from "../otmscan/sellhedge.js";

// Accept a raw chain array OR a { instruments:[...] } envelope (get_instruments result shape).
const asMetas = (chain) => (Array.isArray(chain) ? chain : chain?.instruments ?? []);

// The listed strike closest to a target (first/lowest wins on a tie — irrelevant on a real grid).
const nearest = (arr, target) =>
  arr.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), arr[0]);

// pickExpiry(chain, nowMs, { maxDays, minLeadMs }) — the nearest LIVE expiry for auto-construct: the
// smallest distinct expiration_timestamp strictly after nowMs + minLeadMs and at most maxDays·24h out
// (boundary inclusive). minLeadMs lets the caller skip expiries already inside the pre-expiry blackout
// (opening into delta decay is never right — the NEXT expiry is the honest auto-pick then).
// Accepts the same chain shapes as buildStructure. Returns the timestamp (ms) or null if none qualify.
export function pickExpiry(chain, nowMs, { maxDays = 3, minLeadMs = 0 } = {}) {
  const horizon = nowMs + maxDays * 86400000;
  let best = null;
  for (const m of asMetas(chain)) {
    const t = m?.expiration_timestamp;
    if (!Number.isFinite(t) || t <= nowMs + minLeadMs || t > horizon) continue;
    if (best === null || t < best) best = t;
  }
  return best;
}

// Build the 4-leg structure from strategy params + an option chain + a live snapshot.
// params = { expiry(ms), callOffsetPct, putOffsetPct, qty, execStyle }. Returns { error } (Russian) if a
// strike/instrument can't be resolved. entryDebitUsd is positive for a net debit paid.
export function buildStructure(params, chain, snapshot) {
  const underlying = snapshot?.underlying;
  if (!Number.isFinite(underlying)) return { error: "Нет цены базового актива в снапшоте" };

  const metas = asMetas(chain).filter((m) => m.expiration_timestamp === params.expiry);
  if (!metas.length) return { error: "Нет опционов для выбранной экспирации" };

  const strikes = [...new Set(metas.map((m) => m.strike))].sort((a, b) => a - b);
  const atm = nearest(strikes, underlying);
  const kc = nearest(strikes, atm * (1 + params.callOffsetPct / 100));
  const kp = nearest(strikes, atm * (1 - params.putOffsetPct / 100));

  const findMeta = (strike, type) => metas.find((m) => m.strike === strike && m.option_type === type);
  // ATM straddle long; OTM wings short. Order is load-bearing: [atmCall, atmPut, otmCall, otmPut].
  const plan = [
    [findMeta(atm, "call"), "long", atm, "call"],
    [findMeta(atm, "put"), "long", atm, "put"],
    [findMeta(kc, "call"), "short", kc, "call"],
    [findMeta(kp, "put"), "short", kp, "put"],
  ];
  for (const [meta, , strike, type] of plan) {
    if (!meta) return { error: `Не найден инструмент: страйк ${strike} (${type})` };
  }

  const legs = plan.map(([meta, side]) => {
    const snap = snapshot?.legs?.[meta.instrument_name];
    const qtyAbs = params.qty;
    return {
      instrument: meta.instrument_name,
      type: meta.option_type, // "call" | "put"
      side, // "long" | "short"
      strike: meta.strike,
      expiryMs: meta.expiration_timestamp,
      qtyAbs,
      qtySigned: side === "long" ? qtyAbs : -qtyAbs,
      entryMark: snap?.mark ?? null, // USD premium at open (null if the leg wasn't quoted)
      contractSize: snap?.contractSize ?? meta.contract_size,
      minTradeAmount: snap?.minTradeAmount ?? meta.min_trade_amount,
      tickSize: snap?.tickSize ?? meta.tick_size,
      markInUsd: snap?.markInUsd ?? true, // linear USDC options quote premium in USD
    };
  });

  // Σ qtySigned·entryMark·contractSize — positive = net debit paid to open.
  const entryDebitUsd = legs.reduce((s, l) => s + l.qtySigned * (l.entryMark ?? 0) * l.contractSize, 0);

  return {
    expiryMs: params.expiry,
    params: {
      callOffsetPct: params.callOffsetPct,
      putOffsetPct: params.putOffsetPct,
      qty: params.qty,
      execStyle: params.execStyle,
    },
    strikes: { atm, kc, kp },
    legs,
    entryDebitUsd,
    entryUnderlying: underlying,
  };
}

// ── ПРОДАЖА ОДНОЙ НОГИ (схема sellhedge.js) ─────────────────────────────────────────────────────
//
// ПОЧЕМУ ЗДЕСЬ, А НЕ В ОТДЕЛЬНОМ МОДУЛЕ. Прибыльная схема проекта - продажа колла срока 336-672 ч с
// |дельтой| у 0.45 и дельта-хеджем перпом до экспирации. Её ПРАВИЛА лежат в `otmscan/sellhedge.js` и
// покрыты тестами; сюда они не переписываются, а ВЫЗЫВАЮТСЯ (`pickSellLeg`, `lotsByMargin`). Всё
// остальное, что схеме нужно, у бота 2 уже есть и к числу ног безразлично: `decideHedge`+`applyFill`
// (хедж), `structureMargin` (залог тем же `legMargin`, каким его считает эталон), `accrueFunding`,
// `settleStructure` (единственный выход схемы - дожить до экспирации), леджер и счёт. Четырёхногость
// бота 2 жила ровно в двух местах - `buildStructure` ниже и формула тента в `payoff.js`; второе
// обобщено по ногам, первое дополнено этим строителем. Отдельный модуль-исполнитель означал бы
// ВТОРОЙ жизненный цикл рядом с `evaluate`, то есть ровно тот дефект («две части системы решают одну
// задачу разными правилами»), который проект ловил четырежды.
//
// РАЗМЕР СЧИТАЕТСЯ ОТ ЗАЛОГА, А НЕ ОТ ПРЕМИИ: продавца связывает маржа (замер: $92 за лот против
// премии $21.91), и правило этого счёта - `lotsByMargin`, а не покупательский `computeSizing`.

// Строки поверхности из живого снимка: `pickSellLeg` читает формат записи сканера (h/s/m/d/b/a/iv/vg),
// а бот 2 живёт на тикерах Deribit. Адаптер нужен затем, чтобы движок звал ПРАВИЛО, а не повторял его.
// Инструмент без тикера в снимке не строится вовсе: нога без марка, дельты или веги правилом не
// оценивается, и подставлять сюда оценку вместо наблюдения нельзя.
export function sellRowsFromSnapshot(chain, snapshot, nowMs) {
  const rows = [];
  for (const m of asMetas(chain)) {
    const g = snapshot?.legs?.[m?.instrument_name];
    if (!g) continue;
    rows.push({
      n: m.instrument_name,
      e: m.expiration_timestamp,
      k: m.strike,
      s: m.option_type === "call" ? "C" : "P",
      h: (m.expiration_timestamp - nowMs) / 3600000,
      m: g.mark,
      d: g.delta,
      b: g.bid,
      a: g.ask,
      iv: g.markIv,
      vg: g.vega,
    });
  }
  return rows;
}

// buildSellStructure(params, chain, snapshot, nowMs) → структура из ОДНОЙ короткой ноги в той же
// форме, что и четырёхногая (id/createdAt/engineCfg штампует engine.js).
//   params.qty       - размер; null ⇒ считается от залога по `lotsByMargin` при params.equityUsd;
//   params.sellCfg   - перекрытие SELLHEDGE_DEFAULTS (окно срока, дельта, лот, доля счёта);
//   params.equityUsd - счёт для расчёта размера (нужен только при qty == null).
export function buildSellStructure(params, chain, snapshot, nowMs) {
  const underlying = snapshot?.underlying;
  if (!Number.isFinite(underlying)) return { error: "Нет цены базового актива в снапшоте" };
  const cfg = { ...SELLHEDGE_DEFAULTS, ...(params?.sellCfg ?? {}) };
  const leg = pickSellLeg(sellRowsFromSnapshot(chain, snapshot, nowMs), cfg);
  if (!leg) return { error: `Нет колла в окне ${cfg.expiryMinH}-${cfg.expiryMaxH} ч с |дельтой| у ${cfg.deltaTarget}` };

  const meta = asMetas(chain).find((m) => m.instrument_name === leg.n);
  const g = snapshot.legs[leg.n];
  const index = snapshot.index ?? underlying;
  const contractSize = g.contractSize ?? meta?.contract_size ?? 1;
  // Залог ЗА ОДИН КОНТРАКТ - та же функция и те же аргументы, что у эталона (mark, underlying, index).
  const imPerContract = legMargin({
    type: "call", side: "short", strike: leg.k, mark: leg.m, underlying, index, amount: 1,
  }).im;

  let qtyAbs = params?.qty ?? null;
  let sizing = null;
  if (qtyAbs == null) {
    if (!Number.isFinite(params?.equityUsd)) return { error: "Нет счёта для расчёта размера от залога" };
    const s = lotsByMargin({ imUsdPerContract: imPerContract, equityUsd: params.equityUsd, cfg });
    sizing = { ...s, imPerContract };
    // ОТКАЗ НАЗЫВАЕТ НУЖНЫЙ ДЕПОЗИТ, А НЕ ТОЛЬКО ФАКТ НЕХВАТКИ. Дефолтный бумажный счёт $100 не даёт
    // ни одного лота (медиана залога за лот $92-102 при потолке развёртывания 70%), то есть на чистом
    // профиле схема не открывается НИКОГДА, и оператору надо сказать не «не помещается», а сколько
    // именно завести. Правило размера при этом не трогается: оно совпадает с эталоном и закреплено
    // тестом, а ноль лотов при недостаточном счёте это верный ответ, а не дефект.
    if (!(s.lots >= 1)) {
      const need = Math.ceil((s.imLotUsd ?? 0) / (cfg.deployPct || 1));
      return { error: `Залог $${Math.round(s.imLotUsd ?? 0)} за лот не помещается в счёт $${Math.round(params.equityUsd)}: `
        + `нужно от $${need} (потолок развёртывания ${Math.round((cfg.deployPct || 0) * 100)}% счёта)`, sizing };
    }
    qtyAbs = s.lots * cfg.lot;
  } else {
    sizing = { lots: Math.round(qtyAbs / cfg.lot), imLotUsd: imPerContract * cfg.lot, imUsedUsd: imPerContract * qtyAbs, imPerContract };
  }

  // ИЗДЕРЖКИ ВХОДА В ОПЦИОН. Бот 2 их не моделировал вовсе (структура открывалась по entryMark без
  // комиссии), а у эталона это отдельная статья итога. Считает её `openSellTrade` тем же
  // `computeTradeCosts` - единым источником издержек проекта; здесь только подача. ДО ЭКСПИРАЦИИ
  // ПЛАТИТСЯ ТОЛЬКО ВХОД: опцион гасится сам, второй раз книгу пересекать не надо.
  const half = halfSpreadUsd(leg, cfg);
  const costs = computeTradeCosts({
    markUsd: leg.m, bidUsd: leg.m - half, askUsd: leg.m + half, indexPrice: underlying, execModel: cfg.execModel,
  });
  const open = costs ? openSellTrade({ leg, spotUsd: underlying, costs, imUsd: imPerContract, cfg }) : null;
  if (!open) return { error: `Не считаются издержки входа: нет bid/ask/mark у ${leg.n}` };

  const legs = [{
    instrument: leg.n,
    type: "call",
    side: "short",
    strike: leg.k,
    expiryMs: leg.e,
    qtyAbs,
    qtySigned: -qtyAbs,
    entryMark: g.mark ?? null,
    contractSize,
    minTradeAmount: g.minTradeAmount ?? meta?.min_trade_amount ?? cfg.lot,
    tickSize: g.tickSize ?? meta?.tick_size ?? null,
    markInUsd: g.markInUsd ?? true,
  }];
  return {
    expiryMs: leg.e,
    kind: "sell-call",
    params: { qty: qtyAbs, execStyle: params?.execStyle, sellCfg: params?.sellCfg ?? null },
    // Страйк проданной ноги под тем же ключом `atm`, каким его читает UI; тента у этой структуры нет,
    // поэтому kc/kp отсутствуют и геометрия тента (breakEvens/plateau) честно отдаёт null.
    strikes: { atm: leg.k },
    legs,
    entryDebitUsd: legs.reduce((s, l) => s + l.qtySigned * (l.entryMark ?? 0) * l.contractSize, 0),
    entryUnderlying: underlying,
    entryCostUsd: open.optCost * qtyAbs * contractSize,
    pickedLeg: { name: leg.n, strike: leg.k, expiryMs: leg.e, mark: leg.m, delta: leg.d, ivPct: leg.iv, bid: leg.b, ask: leg.a, vega: leg.vg, hoursToExpiry: leg.h },
    costs,
    sizing,
  };
}

// Net option delta (BTC): Σ qtySigned·delta over the structure legs. The perp hedge cancels this.
export function optionDeltaTotal(structure, snapshot) {
  return structure.legs.reduce((s, l) => s + l.qtySigned * (snapshot.legs?.[l.instrument]?.delta ?? 0), 0);
}

// Net structure greeks — each Σ qtySigned·greek.
export function netGreeks(structure, snapshot) {
  const acc = { delta: 0, gamma: 0, vega: 0, theta: 0 };
  for (const l of structure.legs) {
    const g = snapshot.legs?.[l.instrument];
    if (!g) continue;
    acc.delta += l.qtySigned * (g.delta ?? 0);
    acc.gamma += l.qtySigned * (g.gamma ?? 0);
    acc.vega += l.qtySigned * (g.vega ?? 0);
    acc.theta += l.qtySigned * (g.theta ?? 0);
  }
  return acc;
}

// Current net value of the structure at the snapshot marks: Σ qtySigned·mark·contractSize.
export function netDebit(structure, snapshot) {
  const debitUsd = structure.legs.reduce((s, l) => {
    const g = snapshot.legs?.[l.instrument];
    return g ? s + l.qtySigned * (g.mark ?? 0) * l.contractSize : s;
  }, 0);
  return { debitUsd };
}

// structureRejections(structure, metaByInstrument) — the pre-open sanity checks as STRUCTURED
// rejections [{ code, severity, detail }] for the pre-trade panel: "structure" (экспирации ног
// расходятся / нет метаданных), "min_size" (кол-во ниже минимального лота Deribit), "step_size"
// (кол-во не на сетке лота). severity is always "block" — every rejection forbids opening. All legs
// carry the same params.qty, so the list is deduped to one rejection per code (the first offending
// leg names the detail); a leg below the minimal lot reports min_size only (off-grid follows anyway).
export function structureRejections(structure, metaByInstrument = {}) {
  const rejections = [];
  const seen = new Set();
  const push = (code, detail) => {
    if (seen.has(code)) return; // one entry per reason — duplicates across legs add only noise
    seen.add(code);
    rejections.push({ code, severity: "block", detail });
  };

  const legs = structure?.legs ?? [];
  const exp0 = legs[0]?.expiryMs;
  if (legs.some((l) => l.expiryMs !== exp0)) push("structure", "Экспирации ног не совпадают");
  for (const l of legs) {
    const meta = metaByInstrument[l.instrument];
    const min = meta?.min_trade_amount ?? l.minTradeAmount;
    if (!Number.isFinite(min)) {
      push("structure", `${l.instrument}: нет метаданных инструмента`);
      continue;
    }
    if (l.qtyAbs < min) {
      push("min_size", `${l.instrument}: кол-во ${l.qtyAbs} ниже минимального лота ${min} (Deribit)`);
      continue;
    }
    const steps = l.qtyAbs / min;
    if (Math.abs(steps - Math.round(steps)) > 1e-9)
      push("step_size", `${l.instrument}: кол-во ${l.qtyAbs} не кратно шагу ${min}`);
  }
  return rejections;
}

// Pre-open sanity checks against the instrument metas. metaByInstrument = { [instrument]: meta }.
// errors are short Russian strings; ok is true only when empty. Kept as the stable { ok, errors }
// contract for engine.js / main.js — a thin wrapper over the structured rejections above.
export function validateStructure(structure, metaByInstrument = {}) {
  const errors = structureRejections(structure, metaByInstrument).map((r) => r.detail);
  return { ok: errors.length === 0, errors };
}
