// structure.js — «BTC-опционы» (Strategy One) 4-leg winged-straddle STRUCTURE builder + net-greek/debit
// aggregators + pre-trade gates (pickExpiry / structureRejections). PURE: no fetch / fs / DOM / Date.now —
// time comes in as nowMs, so everything is deterministic and unit-testable. The structure is the paper
// position (long ATM call + long ATM put − short OTM call − short OTM put); market greeks come FROM the
// composite snapshot (Deribit), never priced here. engine.js later stamps id/createdAt — NOT here.

import { legMargin, lotsByStressMargin } from "./margin.js";
import { computeTradeCosts } from "../otmscan/economics.js";
import { resolveSellCfg, rankSellLegs, lotsByMargin, halfSpreadUsd, openSellTrade } from "../otmscan/sellhedge.js";
import { rankStranglePairs, openStrangleTrade } from "../otmscan/sellstrangle.js";
import { SELL_SANITY_DEFAULTS, evaluateInstrumentSanity, summarizeSanityFailure } from "../otmscan/sanity.js";

// Accept a raw chain array OR a { instruments:[...] } envelope (get_instruments result shape).
const asMetas = (chain) => (Array.isArray(chain) ? chain : chain?.instruments ?? []);

// The listed strike closest to a target (first/lowest wins on a tie — irrelevant on a real grid).
const nearest = (arr, target) =>
  arr.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), arr[0]);

// Справочный спот строителя: underlying снапшота, а когда источник ПОМЕТИЛ опционный спот протухшим
// (snapshot.spot, deribit.js) и рядом есть живой индекс - индекс. Выбор ATM-страйка по споту
// суточной давности сместил бы страйки на весь дневной ход цены (живой прогон 24-25.08.2026:
// S залип на 77394.16 при живом индексе). Синтетические снапшоты проб ({ underlying }) и реплей
// записи метки spot не несут и принимаются как есть - за их свежесть отвечает вызывающий.
const refSpot = (snapshot) =>
  snapshot?.spot?.stale && Number.isFinite(snapshot.index) ? snapshot.index : snapshot?.underlying;

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
  const underlying = refSpot(snapshot);
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
      // Поля санитарии (sanity.js): метка тикера и глубина книги. Правило выбора ноги их не
      // читает; у строк записи их нет вовсе, и там санитария вырождается настройкой.
      ts: g.ts ?? null,
      bidDepthUsd: g.book?.bidDepthUsd ?? null,
      askDepthUsd: g.book?.askDepthUsd ?? null,
    });
  }
  return rows;
}

// ── РАЗМЕР ПРОДАВЦА ПО ПРАВИЛУ СХЕМЫ: одно место на оба строителя (колл и пара) - иначе смена
// правила означала бы две правки и однажды одну забытую. Правила два:
//   "deploy" - боевое lotsByMargin: лоты от доли IM на входе (deployPct);
//   "stress" - АВТОНОМНОЕ lotsByStressMargin: лоты от двухсторонней стресс-маржи (MM при споте
//              ×(1±stressXPct%) не выше stressCapFrac·счёта); движок считает размер сам на каждом
//              входе из живых величин ног, константы зафиксированы замером (сетка eval-accel
//              --size-rule stress при критерии равного хвоста), а не выбором оператора.
// Поверх обоих - предел биржи: залога (IM) не поставить больше счёта. Это ограничение исполнения,
// а не правила, поэтому живёт здесь, у строителя, а не внутри lotsByStressMargin.
//
// ОТКАЗ НАЗЫВАЕТ ПРИЧИНУ ЧИСЛОМ, А НЕ ТОЛЬКО ФАКТ НЕХВАТКИ (перенесено из строителя колла):
// дефолтный бумажный счёт $100 не даёт ни одного лота, и оператору надо сказать, сколько именно
// завести; ноль лотов при недостаточном счёте - верный ответ, а не дефект.
// РЯДОМ С ТЕКСТОМ ОТКАЗ НЕСЁТ КОД "no-lots" - ОДИН НА ОБЕ ВЕТКИ ПРАВИЛА: по нему жетон цепочки
// судит «СТОП: размер не помещается в счёт», не разбирая русский текст. Судья по словам уже
// промолчал однажды: тексты веток разные, и отказ стресс-ветки не попадал под /залог|депозит/
// детектора карточки (сверка руководства 2026-08-27).
function sellSizingByRule({ cfg, equityUsd, imPerContract, stressLegs, indexUsd, what = null }) {
  if (!Number.isFinite(equityUsd)) return { error: "Нет счёта для расчёта размера от залога" };
  const imLotUsd = imPerContract * cfg.lot;
  if (cfg.sizeRule === "stress") {
    const st = lotsByStressMargin({ legs: stressLegs, indexUsd, equityUsd,
      xPct: cfg.stressXPct, capFrac: cfg.stressCapFrac, lot: cfg.lot });
    const lots = Math.max(0, Math.min(st.lots, Math.floor(equityUsd / Math.max(imLotUsd, 1e-9))));
    const sizing = { lots, imLotUsd, imUsedUsd: lots * imLotUsd, imPerContract, rule: "stress",
      stress: { xPct: cfg.stressXPct, capFrac: cfg.stressCapFrac,
        mm1Up: st.mm1Up, mm1Down: st.mm1Down, bindingSide: st.bindingSide } };
    if (!(lots >= 1)) {
      const bindLot = Math.max(st.mm1Up ?? 0, st.mm1Down ?? 0) * cfg.lot;
      return { error: `Стресс-правило не даёт ни лота${what ? ` (${what})` : ""}: MM при ±${cfg.stressXPct}% `
        + `спота $${Math.round(bindLot)} за лот против ${Math.round((cfg.stressCapFrac || 0) * 100)}% `
        + `счёта $${Math.round(equityUsd)}`, code: "no-lots", sizing };
    }
    return { sizing, qtyAbs: lots * cfg.lot };
  }
  const s = lotsByMargin({ imUsdPerContract: imPerContract, equityUsd, cfg });
  const sizing = { ...s, imPerContract, rule: "deploy" };
  if (!(s.lots >= 1)) {
    const need = Math.ceil((s.imLotUsd ?? 0) / (cfg.deployPct || 1));
    return { error: `Залог $${Math.round(s.imLotUsd ?? 0)} за лот${what ? ` ${what}` : ""} не помещается в счёт $${Math.round(equityUsd)}: `
      + `нужно от $${need} (потолок развёртывания ${Math.round((cfg.deployPct || 0) * 100)}% счёта)`, code: "no-lots", sizing };
  }
  return { sizing, qtyAbs: s.lots * cfg.lot };
}

// buildSellStructure(params, chain, snapshot, nowMs) → структура из ОДНОЙ короткой ноги в той же
// форме, что и четырёхногая (id/createdAt/engineCfg штампует engine.js).
//   params.qty       - размер; null ⇒ считается от залога по `lotsByMargin` при params.equityUsd;
//   params.sellCfg   - перекрытие SELLHEDGE_DEFAULTS (окно срока, дельта, лот, доля счёта);
//   params.equityUsd - счёт для расчёта размера (нужен только при qty == null).
export function buildSellStructure(params, chain, snapshot, nowMs) {
  const underlying = refSpot(snapshot);
  if (!Number.isFinite(underlying)) return { error: "Нет цены базового актива в снапшоте" };
  const cfg = resolveSellCfg(params?.sellCfg);

  // САНИТАРИЯ (§1.8 дизайна): вето переключает контракт, а не останавливает цепочку. Кандидаты
  // идут в порядке близости дельты; не прошла нога - берётся следующая в допуске; не прошла ни
  // одна - отказ с кодом, по которому вызывающий заводит окно ожидания; ожидание дольше окна -
  // вызывающий передаёт allowDegraded, и открывается лучшая по дельте с ПОСТОЯННОЙ пометкой
  // «ухудшенная санитария» на структуре и сделке цепочки. Санитария живёт здесь, а не в main.js,
  // чтобы прогон записи исполнял ту же функцию и вторая реализация не появилась.
  const sanityCfg = { ...SELL_SANITY_DEFAULTS, ...(params?.sanityCfg ?? {}) };
  const cands = rankSellLegs(sellRowsFromSnapshot(chain, snapshot, nowMs), cfg, sanityCfg.maxCandidates);
  if (!cands.length) {
    return { error: `Нет колла в окне ${cfg.expiryMinH}-${cfg.expiryMaxH} ч с |дельтой| у ${cfg.deltaTarget}`, code: "no-leg" };
  }
  const checks = [];
  let leg = null;
  for (const r of cands) {
    const s = evaluateInstrumentSanity(r, sanityCfg, nowMs);
    checks.push(s);
    if (s.verdict === "pass") { leg = r; break; }
  }
  let sanityMark = "ok";
  if (!leg) {
    if (!params?.allowDegraded) {
      return {
        error: `Санитария: ни одна из ${cands.length} ног в допуске дельты не прошла (${summarizeSanityFailure(checks)})`,
        code: "sanity-none-passed",
        sanityChecks: checks,
      };
    }
    leg = cands[0];
    sanityMark = "degraded";
  }

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
    // Правило размера (deploy | stress) и предел биржи - в sellSizingByRule, одном на оба строителя.
    const sz = sellSizingByRule({ cfg, equityUsd: params?.equityUsd, imPerContract,
      stressLegs: [{ type: "call", strike: leg.k, mark: leg.m }], indexUsd: index });
    if (sz.error) return { error: sz.error, code: sz.code, sizing: sz.sizing };
    sizing = sz.sizing;
    qtyAbs = sz.qtyAbs;
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
    sanity: sanityMark,
    sanityChecks: checks,
  };
}

// ── ПРОДАЖА СТРЭНГЛА (правила sellstrangle.js; исследование «ускорение оборота» 2026-08-26) ─────
//
// Тот же довод, что у buildSellStructure выше: правила пары (какую пару, каким размером, почём
// вход) лежат в движке otmscan и сюда НЕ переписываются, а вызываются; всё остальное у бота 2 уже
// мультиногое и к числу коротких ног безразлично - `structureMargin` суммирует ноги, `payoffAt` и
// расчёт в экспирацию считают по списку ног, `optionDeltaTotal` отдаёт НЕТТО-дельту, которую и
// хеджирует decideHedge (ровно то правило, каким пара измерена: полоса 0.03·q на нетто-дельте,
// замер при равном хвосте дал ×4.09 против ×2.59 у одиночного колла). Отдельного исполнителя у
// стрэнгла нет и не появляется.
//
// САНИТАРИЯ НА ПАРЕ (§1.8): кандидаты - ПАРЫ в порядке близости колла к целевой дельте
// (`rankStranglePairs`; колл без пута своей экспирации пропущен правилом, а не санитарией).
// Пара проходит, только когда проходят ОБЕ ноги; вето любой ноги переключает на следующую пару;
// не прошла ни одна - отказ с кодом, ожидание дольше окна - лучшая пара с постоянной пометкой
// «ухудшенная санитария». Правило то же, что у одной ноги, применённое к обеим.
export function buildSellStrangleStructure(params, chain, snapshot, nowMs) {
  const underlying = refSpot(snapshot);
  if (!Number.isFinite(underlying)) return { error: "Нет цены базового актива в снапшоте" };
  const cfg = resolveSellCfg(params?.sellCfg);
  const sanityCfg = { ...SELL_SANITY_DEFAULTS, ...(params?.sanityCfg ?? {}) };
  const pairs = rankStranglePairs(sellRowsFromSnapshot(chain, snapshot, nowMs), cfg, sanityCfg.maxCandidates);
  if (!pairs.length) {
    return { error: `Нет пары колл+пут одной экспирации в окне ${cfg.expiryMinH}-${cfg.expiryMaxH} ч с |дельтой| у ${cfg.deltaTarget}`, code: "no-leg" };
  }
  const checks = [];
  let pair = null;
  for (const p of pairs) {
    const sc = evaluateInstrumentSanity(p.call, sanityCfg, nowMs);
    const sp = evaluateInstrumentSanity(p.put, sanityCfg, nowMs);
    checks.push(sc, sp);
    if (sc.verdict === "pass" && sp.verdict === "pass") { pair = p; break; }
  }
  let sanityMark = "ok";
  if (!pair) {
    if (!params?.allowDegraded) {
      return {
        error: `Санитария: ни одна из ${pairs.length} пар в допуске дельты не прошла (${summarizeSanityFailure(checks)})`,
        code: "sanity-none-passed",
        sanityChecks: checks,
      };
    }
    pair = pairs[0];
    sanityMark = "degraded";
  }

  const index = snapshot.index ?? underlying;
  const metaOf = (leg) => asMetas(chain).find((m) => m.instrument_name === leg.n);
  const gOf = (leg) => snapshot.legs[leg.n];
  // Залог пары ЗА ОДИН контракт = сумма требований ног (стандартная маржа Deribit короткие ноги не
  // неттингует); формулы те же, что у эталона и живого счёта - legMargin, по типу каждой ноги.
  const imPerContract =
    legMargin({ type: "call", side: "short", strike: pair.call.k, mark: pair.call.m, underlying, index, amount: 1 }).im
    + legMargin({ type: "put", side: "short", strike: pair.put.k, mark: pair.put.m, underlying, index, amount: 1 }).im;

  let qtyAbs = params?.qty ?? null;
  let sizing = null;
  if (qtyAbs == null) {
    // То же правило размера, что у одной ноги; стресс-ноги - ОБЕ (пара двухсторонняя по природе).
    const sz = sellSizingByRule({ cfg, equityUsd: params?.equityUsd, imPerContract,
      stressLegs: [{ type: "call", strike: pair.call.k, mark: pair.call.m },
        { type: "put", strike: pair.put.k, mark: pair.put.m }],
      indexUsd: index, what: "пары" });
    if (sz.error) return { error: sz.error, code: sz.code, sizing: sz.sizing };
    sizing = sz.sizing;
    qtyAbs = sz.qtyAbs;
  } else {
    sizing = { lots: Math.round(qtyAbs / cfg.lot), imLotUsd: imPerContract * cfg.lot, imUsedUsd: imPerContract * qtyAbs, imPerContract };
  }

  // Издержки входа: каждая нога платит половину СВОЕГО круга (правило openStrangleTrade, тем же
  // computeTradeCosts). Взвешенный по премиям круг кладётся в costs.roundTripCostPct, чтобы строка
  // `open-cost` леджера читалась одним числом, как у одной ноги; поногово лежит рядом.
  const mkCosts = (leg) => {
    const half = halfSpreadUsd(leg, cfg);
    return computeTradeCosts({ markUsd: leg.m, bidUsd: leg.m - half, askUsd: leg.m + half, indexPrice: underlying, execModel: cfg.execModel });
  };
  const costsCall = mkCosts(pair.call);
  const costsPut = mkCosts(pair.put);
  const open = costsCall && costsPut
    ? openStrangleTrade({ pair, spotUsd: underlying, costsCall, costsPut, imUsd: imPerContract, cfg })
    : null;
  if (!open) return { error: `Не считаются издержки входа: нет bid/ask/mark у ${pair.call.n} или ${pair.put.n}` };
  const premPair = pair.call.m + pair.put.m;

  const mkLeg = (leg, type) => {
    const meta = metaOf(leg);
    const g = gOf(leg);
    return {
      instrument: leg.n,
      type,
      side: "short",
      strike: leg.k,
      expiryMs: leg.e,
      qtyAbs,
      qtySigned: -qtyAbs,
      entryMark: g.mark ?? null,
      contractSize: g.contractSize ?? meta?.contract_size ?? 1,
      minTradeAmount: g.minTradeAmount ?? meta?.min_trade_amount ?? cfg.lot,
      tickSize: g.tickSize ?? meta?.tick_size ?? null,
      markInUsd: g.markInUsd ?? true,
    };
  };
  // Порядок ног ЗНАЧИМ и закреплён: [колл, пут]. Закон равных ног (unit по legs[0]) выполняется,
  // а вызывающие (книга сверки, карточка цепочки) читают колл первым.
  const legs = [mkLeg(pair.call, "call"), mkLeg(pair.put, "put")];
  const info = (leg) => ({ name: leg.n, strike: leg.k, expiryMs: leg.e, mark: leg.m, delta: leg.d,
    ivPct: leg.iv, bid: leg.b, ask: leg.a, vega: leg.vg, hoursToExpiry: leg.h });
  return {
    expiryMs: pair.call.e,
    kind: "sell-strangle",
    params: { qty: qtyAbs, execStyle: params?.execStyle, sellCfg: params?.sellCfg ?? null },
    // Страйки пары под теми же ключами, какими четырёхногая структура зовёт крылья; `atm` у пары
    // нет намеренно - середины у стрэнгла не существует, и подставлять туда что-либо значило бы
    // рисовать тент там, где его нет.
    strikes: { kc: pair.call.k, kp: pair.put.k },
    legs,
    entryDebitUsd: legs.reduce((s, l) => s + l.qtySigned * (l.entryMark ?? 0) * l.contractSize, 0),
    entryUnderlying: underlying,
    entryCostUsd: open.optCost * qtyAbs * (legs[0].contractSize ?? 1),
    // pickedLeg = КОЛЛ пары: зона продавца и сверка книг судят режим рынка по колловой ноге - тем
    // же числом, каким его судит базовая схема, иначе один режим назывался бы двумя именами.
    pickedLeg: info(pair.call),
    pickedPair: { call: info(pair.call), put: info(pair.put) },
    costs: {
      roundTripCostPct: (costsCall.roundTripCostPct * pair.call.m + costsPut.roundTripCostPct * pair.put.m) / premPair,
      call: costsCall,
      put: costsPut,
    },
    sizing,
    sanity: sanityMark,
    sanityChecks: checks,
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
