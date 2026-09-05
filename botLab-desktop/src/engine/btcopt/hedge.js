// hedge.js - «BTC-опционы» (Strategy One) delta-hedge decision engine.
// PURE: no electron / DOM / fs / fetch - deterministic and unit-testable. Every time-dependent
// function takes an explicit `nowMs` (never Date.now()) so the caller owns the clock and tests
// are reproducible.
//
// The 4-leg options structure carries an aggregate delta (optionDelta, in BTC). A BTC perpetual
// leg (Qperp, signed BTC) is traded to keep the book near delta-neutral. This module decides
// WHETHER to re-hedge (delta / price / time triggers gated by a benefit-vs-cost filter), sizes
// the perp order, and - on fill - updates the inverse-perp position state (P&L in USD).
//
// Units: deltas are BTC; perp fills are quoted in BTC then converted to Deribit $10 inverse
// contracts. Costs/benefits/realized-P&L are USD.

// Round a raw BTC quantity to the exchange step (e.g. minTradeAmount). Sign is preserved by
// Math.round; step<=0 is a pass-through (no rounding).
export function roundToStep(x, step) {
  return step > 0 ? Math.round(x / step) * step : x;
}

// ── Deadband scaling ────────────────────────────────────────────────────────────────────────────
// The structure size deadbandBtc is calibrated AT. Default = the engine's default qty, so the band
// a live profile actually hedges by is unchanged by the scaling below.
export const DEADBAND_REF_QTY = 0.01;

// effectiveDeadband({ deadbandBtc, structureQty, refQty }) → the ±BTC half-width to hedge by.
//
// WHY A FLAT NUMBER WAS A DEFECT, and it is subtler than "it does not scale". deadbandBtc is a band
// on the structure's DELTA, and that delta grows linearly with position size. Held flat while size
// grows, the band silently TIGHTENS in relative terms: at 5x the size it admits a fifth of the
// relative drift, so the same market produces several times the re-hedges and several times the
// fees, with nobody having asked for it.
//
// THE REAL DEFECT WAS THE MISSING ANCHOR. The number never said which size it was calibrated for,
// and the codebase disagreed with itself about the answer: the spec's worked example runs at qty 1
// (net delta −0.0019 against a 0.001 band, so the band is about half the delta), while the shipped
// default is qty 0.01 (the $100 paper deposit). Same number, two meanings, differing by 100x. Making
// the anchor an explicit setting is the fix; choosing a different anchor is a CALIBRATION decision
// and is deliberately left to the operator, not smuggled in here.
//
// Scaling is LINEAR in size for the same reason the delta is: holding band/delta constant keeps the
// hedge's relative tightness (and therefore its cost) invariant to how much capital is deployed.
// A missing or non-positive size falls back to the raw setting rather than guessing.
export function effectiveDeadband({ deadbandBtc, structureQty, refQty = DEADBAND_REF_QTY } = {}) {
  if (!(deadbandBtc >= 0)) return 0;
  if (!(structureQty > 0) || !(refQty > 0)) return deadbandBtc;
  return deadbandBtc * (structureQty / refQty);
}

// The price move fraction the benefit estimate is tuned to protect against.
//
// SEPARATE KNOB, AND ITS ABSENCE WAS A DEFECT. Until 2026-08-13 expectedBenefit read
// cfg.priceTriggerPct for this, so ONE number meant two unrelated things: the threshold at which
// the price trigger fires, and the size of the move the benefit is measured against. They could
// neither be tuned apart nor even MEASURED apart (a parity run isolating the benefit filter had to
// arm the price trigger with it). benefitMovePct now carries the modelling assumption; the fallback
// to priceTriggerPct preserves the behaviour of any profile written before the split.
export function benefitMoveFrac(cfg) {
  const pct = cfg?.benefitMovePct ?? cfg?.priceTriggerPct;
  return Number.isFinite(pct) ? pct / 100 : 0;
}

// Settlement / expiry blackout window. Hedging pauses around the daily 08:00 UTC settlement and
// in the final minutes before an expiry (thin books, settlement prints - hedges there are noise).
//   secOfDay via the (%+%)% idiom so a negative nowMs still maps into [0,86400).
//   dailyActive:  within ±dailyWindowSec of 08:00 UTC (28800s).
//   preActive:    expiry is in the future and within preExpirySec.
export function settlementBlackout(nowMs, expiryMs, cfg) {
  const secOfDay = (((nowMs / 1000) % 86400) + 86400) % 86400;
  const dailyActive = Math.abs(secOfDay - 28800) <= cfg.dailyWindowSec;
  const preActive =
    expiryMs != null && expiryMs - nowMs >= 0 && expiryMs - nowMs <= cfg.preExpirySec * 1000;
  const active = dailyActive || preActive;
  const reason = dailyActive ? "settlement-0800" : preActive ? "pre-expiry" : null;
  return { active, reason };
}

// Which re-hedge triggers are armed this cycle. Any one firing is enough to consider a hedge (the
// benefit/cost filter still has the final say). `deltaExcess` is how far |totalDelta| pokes past
// the deadband; `timeFired` measures from the last hedge (or, before the first hedge, createdAt).
export function computeTriggers({
  totalDelta,
  deadband,
  underlying,
  lastHedgeUnderlying,
  priceTriggerPct,
  nowMs,
  lastHedgeAt,
  rehedgeMs,
  createdAt,
}) {
  const deltaExcess = Math.max(0, Math.abs(totalDelta) - deadband);
  const deltaFired = deltaExcess > 0;
  const priceMovePct = lastHedgeUnderlying
    ? (100 * Math.abs(underlying - lastHedgeUnderlying)) / lastHedgeUnderlying
    : 0;
  const priceFired = priceMovePct >= priceTriggerPct;
  const timeFired = nowMs - (lastHedgeAt ?? createdAt ?? nowMs) >= rehedgeMs;
  const reasons = [];
  if (deltaFired) reasons.push("delta");
  if (priceFired) reasons.push("price");
  if (timeFired) reasons.push("time");
  return { deltaFired, priceFired, timeFired, reasons, deltaExcess, priceMovePct };
}

// Expected $ benefit of re-hedging: the delta we would neutralize times the underlying times m (the
// price-move fraction the trigger is tuned to protect against).
//
// ВЕЛИЧИНА ОДНА И ТА ЖЕ С ИЗДЕРЖКАМИ, И ПРЕЖДЕ ЭТО БЫЛО НЕ ТАК. Выгода мерилась ИЗБЫТКОМ за полосой,
// а издержки - ПОЛНЫМ остатком дельты, который заявка и снимает. Две разные величины в двух половинах
// одного неравенства дают систематический перекос В СТОРОНУ ПРОПУСКА ровно на краю полосы: там
// избыток стремится к нулю, а торгуемый объём равен всей полосе, поэтому выгода занижена в
// (полоса + избыток)/избыток раз, то есть неограниченно. Полоса при этом перестаёт быть решающим
// правилом и превращается в «полоса плюс сколько-то сверху», причём это «сколько-то» нигде не
// названо. Теперь обе половины считаются на ФАКТИЧЕСКИ ТОРГУЕМОМ объёме: он и есть то, за что
// платят комиссию и проскальзывание, и то, что реально снимает риск.
export function expectedBenefit({ deltaBtc, underlying, m }) {
  return Math.abs(deltaBtc) * underlying * m;
}

// ── Ставка комиссии перпа ───────────────────────────────────────────────────────────────────────
// perpFeeRate(perp, cfg, style) → доля от оборота за одно исполнение: maker при style "limit",
// иначе taker. Источник ПЕРВЫМ - снимок перпа (`perp.makerFee` / `perp.takerFee`: deribit.js кладёт
// их из public/get_instrument той же меты, что и contractSize), запасным - cfg (HEDGE_CONSTANTS
// движка либо явные настройки стенда).
//
// ПОЧЕМУ СНИМОК, А НЕ КОНСТАНТА, И ЭТО БЫЛ ДЕФЕКТ УЧЁТА. До 2026-09-05 движок нёс «иллюстративные»
// ставки maker 0 / taker 0.0005, а биржа берёт 0.00015 / 0.00035 (get_instrument BTC-PERPETUAL).
// Бумажный прогон 17.08-05.09 (mbp15) книжил все 87 исполнений хеджа по нулю: при обороте $218 870
// недобрано $32.83, а это самая чувствительная статья схемы продавца (пятилетний замер 26.08:
// стрэнгл 336-672 ×4.09 при 0 б.п. против ×3.18 при 2.5 б.п.). Ставка биржи меняется решением
// биржи, а не релизом приложения, поэтому её место в снимке, рядом с размером контракта, а не в коде.
//
// НОЛЬ И ОТСУТСТВИЕ РАЗЛИЧАЮТСЯ. Ставка 0 от биржи законна и берётся как есть; запасное значение
// включается только когда поля нет вовсе (null/undefined/NaN): записи тиков, стенды и тесты строят
// перп без меты, и там правит cfg - стенды сверок задают ставку замера явными настройками.
export function perpFeeRate(perp, cfg, style) {
  const limit = style === "limit";
  const live = limit ? perp?.makerFee : perp?.takerFee;
  if (Number.isFinite(live)) return live;
  return limit ? cfg.makerFeeRate ?? 0 : cfg.takerFeeRate;
}

// Itemized $ cost of the hedge, execution-style aware (mirrors the fill semantics in engine.js):
// market - fee is round-trip (2x taker) on the traded size and the half-spread is paid; limit
// (post-only) - maker rate and NO spread term (the fill models mid). Обе ставки берутся у биржи из
// снимка перпа, cfg лишь запасное значение (см. perpFeeRate выше).
// slippage stays in BOTH branches as a non-zero cost floor: a real resting order still carries
// non-fill / adverse-selection risk, and a zero total would degenerate the λ filter.
//
// ФАНДИНГ СЧИТАЕТСЯ НА ПРИРАЩЕНИЕ ЗАЯВКИ, А НЕ НА ВСЮ ЦЕЛЕВУЮ ПОЗИЦИЮ, И ЭТО БЫЛ ДЕФЕКТ. Прежде
// сюда шёл `targetQty`, то есть карри ВСЕЙ позиции за восемь часов. Но карри платится независимо от
// того, переложимся мы сейчас или нет: он не является издержкой РЕШЕНИЯ переложиться. Подстановка
// его в маргинальную цену давала два наблюдаемых следствия, оба вредных:
//   1. фиксированная полоса превращалась в ПЛАВАЮЩУЮ, зависящую от ставки фандинга. Замер при полосе
//      0.03 и споте $100k: при нулевом фандинге движок перекладывался на 1.05 полосы, при +1 б.п.
//      за 8 часов на 1.44, при +5 б.п. на 3.03 полосы. Полоса, разъезжающаяся втрое вслед за
//      ставкой, это уже не то число, сеткой которого выбрана 0.03;
//   2. при ОТРИЦАТЕЛЬНОМ фандинге слагаемое становилось отрицательным и могло утянуть весь `total`
//      ниже нуля, а тогда гейт `benefit > total·λ` выполнялся при ЛЮБОЙ выгоде, включая нулевую.
// Правильная маргинальная цена перекладки это комиссия, спред и проскальзывание на торгуемом
// объёме плюс изменение карри, которое эта заявка вносит, то есть фандинг на ПРИРАЩЕНИИ. Знак
// сохранён прежний (зеркало `pnl.accrueFunding`): заявка, наращивающая лонг при положительной
// ставке, добавляет расход; уменьшающая его - экономит.
//
// `total` НЕ зажимается снизу здесь: отдельные статьи и их сумма остаются честной арифметикой, в том
// числе отрицательной. Зажимает потребитель (`decideHedge`), и там же объяснено почему.
export function estimateCost({ hedgeQty, targetQty, perp, liquidity, cfg }) {
  const limit = cfg.execStyle === "limit";
  const feeRate = perpFeeRate(perp, cfg, cfg.execStyle);
  const fee = 2 * Math.abs(hedgeQty) * perp.mark * feeRate;
  const spread = limit ? 0 : Math.abs(hedgeQty) * liquidity.halfSpread;
  const slippage = Math.abs(hedgeQty) * perp.mark * cfg.slippageRate;
  const funding_horizon =
    hedgeQty * perp.mark * perp.funding8h * (cfg.fundingHorizonSec / 28800);
  const total = fee + spread + slippage + funding_horizon;
  // `carry_horizon` - справочная статья: полный карри целевой позиции за горизонт. Он реален и его
  // надо видеть, но он не должен решать, перекладываться ли СЕЙЧАС, поэтому в `total` не входит.
  const carry_horizon = targetQty * perp.mark * perp.funding8h * (cfg.fundingHorizonSec / 28800);
  return { fee, spread, slippage, funding_horizon, carry_horizon, total };
}

// The hedge decision for one evaluation cycle. Returns one of HEDGE / SKIP / BLACKOUT with the
// supporting numbers. `optionDelta` is the structure's aggregate delta (BTC); `Qperp` is the
// current perp delta (BTC). The target futures delta is −optionDelta (fully neutralize options).
export function decideHedge({
  optionDelta,
  Qperp,
  snapshot,
  liquidity,
  cfg,
  nowMs,
  expiryMs,
  createdAt,
  lastHedgeAt,
  lastHedgeUnderlying,
  step,
  structureQty,
}) {
  const totalDelta = optionDelta + Qperp;
  const target = -optionDelta;
  // Полоса масштабируется размером структуры (см. effectiveDeadband). При дефолтном qty 0.01 она
  // равна настройке в точности, поэтому дефолтная конфигурация не меняется.
  const deadband = effectiveDeadband({ deadbandBtc: cfg.deadbandBtc, structureQty, refQty: cfg.deadbandRefQty });
  const blackout = settlementBlackout(nowMs, expiryMs, cfg);

  // (1) blackout gate - do not hedge into settlement / the pre-expiry window.
  if (cfg.settlementBlackout && blackout.active) {
    return {
      decision: "BLACKOUT",
      trigger_reason: [],
      estimated_cost: null,
      estimated_benefit: 0,
      hedge_order: null,
      target_futures_delta: target,
      delta_excess: Math.max(0, Math.abs(totalDelta) - deadband),
      deadband_btc: deadband,
      blackout,
    };
  }

  // (2) which triggers are armed
  const t = computeTriggers({
    totalDelta,
    deadband,
    underlying: snapshot.underlying,
    lastHedgeUnderlying,
    priceTriggerPct: cfg.priceTriggerPct,
    nowMs,
    lastHedgeAt,
    rehedgeMs: cfg.rehedgeSec * 1000,
    createdAt,
  });
  const delta_excess = t.deltaExcess;
  const base = {
    trigger_reason: t.reasons,
    target_futures_delta: target,
    delta_excess,
    // ФАКТИЧЕСКАЯ полоса, по которой принято это решение: она масштабируется размером структуры,
    // и показывать вместо неё настройку значило бы врать в UI ровно там, где решение объясняется.
    deadband_btc: deadband,
    blackout,
  };

  // (3) nothing fired - stand pat
  if (t.reasons.length === 0) {
    return { decision: "SKIP", estimated_cost: null, estimated_benefit: 0, hedge_order: null, ...base };
  }

  // (4) size the perp order to the residual delta, rounded to the exchange step
  const raw = -optionDelta - Qperp;
  const hedgeQty = roundToStep(raw, step);
  if (hedgeQty === 0) {
    return { decision: "SKIP", estimated_cost: null, estimated_benefit: 0, hedge_order: null, ...base };
  }

  // (5) benefit vs itemized cost. ОБЕ ПОЛОВИНЫ НА ОДНОЙ ВЕЛИЧИНЕ: на объёме, который заявка
  // реально снимает (см. шапку expectedBenefit). Прежде выгода мерилась избытком за полосой, а
  // издержки полным остатком, и на краю полосы это давало систематический пропуск.
  const estimated_benefit = expectedBenefit({
    deltaBtc: hedgeQty,
    underlying: snapshot.underlying,
    m: benefitMoveFrac(cfg), // собственный knob, а не порог ценового триггера (см. benefitMoveFrac)
  });
  const estimated_cost = estimateCost({
    hedgeQty,
    targetQty: target,
    perp: snapshot.perp,
    liquidity,
    cfg,
  });

  // (6) trade only if the benefit clears cost·lambda.
  // ИЗДЕРЖКИ ЗАЖИМАЮТСЯ СНИЗУ НУЛЁМ, И ЭТО НЕ ПЕРЕСТРАХОВКА. Фандинг в статьях СО ЗНАКОМ, поэтому
  // при благоприятной ставке `total` может уйти в минус, а тогда `benefit > total·λ` выполняется при
  // ЛЮБОЙ выгоде, включая нулевую: гейт вырождается и перестаёт быть гейтом ровно там, где рынок
  // платит за позицию. Отрицательная цена перекладки не делает саму перекладку бесплатной, поэтому
  // сравнение идёт с max(0, total). Сама статья в отчёте остаётся знаковой и видимой.
  if (estimated_benefit > Math.max(0, estimated_cost.total) * cfg.lambda) {
    return {
      decision: "HEDGE",
      estimated_cost,
      estimated_benefit,
      hedge_order: {
        side: hedgeQty > 0 ? "buy" : "sell",
        amount_btc: Math.abs(raw),
        amount_rounded_btc: Math.abs(hedgeQty),
        order_type: cfg.execStyle,
        post_only: cfg.execStyle === "limit",
      },
      ...base,
    };
  }
  return { decision: "SKIP", estimated_cost, estimated_benefit, hedge_order: null, ...base };
}

// contractsForDelta(perpState, deltaBtc, priceRef, cs) → сколько контрактов сдвигает ДОЛЛАРОВУЮ
// дельту позиции ровно на deltaBtc. Дробное число: округление до целого контракта делает вызывающий.
//
// ПОЧЕМУ НЕ ПРОСТО deltaBtc·P/cs, И ЭТО ВТОРАЯ ПОЛОВИНА ТОГО ЖЕ ДЕФЕКТА. У обратного контракта
// вклад лота в дельту равен q·cs/ЦЕНА_ЛОТА. Значит:
//   ДОБАВЛЕНИЕ открывает НОВЫЙ лот по priceRef, и его вклад q·cs/priceRef ⇒ q = deltaBtc·priceRef/cs;
//   УМЕНЬШЕНИЕ закрывает СТАРЫЕ контракты, несущие базис позиции, и каждый уносит cs/avgEntry
//     ⇒ q = deltaBtc·avgEntry/cs. Пересчёт по текущей цене снимает НЕ СТОЛЬКО, сколько просили;
//   ПЕРЕВОРОТ делает и то, и другое: закрывает всё по базису, остаток открывает по priceRef.
//
// ЗАМЕР, КОТОРЫМ ЭТО ПОЙМАНО (прогон записи, первая сделка 2021-08-16): после каждого УМЕНЬШЕНИЯ
// хеджа движок промахивался мимо своей цели на raw·(P−A)/A, то есть на 1.6% полосы после первой
// перекладки вниз и на 3.7% после второй. На тике 2021-08-17 04:00 промах перевернул решение:
// эталон видел разрыв 0.0302 при полосе 0.03 и перекладывался, движок видел 0.0291 и стоял.
// Знак ошибки следует за тем, выше или ниже цена среднего входа - подпись направленной ставки.
export function contractsForDelta(perpState, deltaBtc, priceRef, cs) {
  const qty = perpState?.qty ?? 0;
  const avgEntry = perpState?.avgEntry ?? 0;
  if (!(cs > 0) || !(priceRef > 0) || !Number.isFinite(deltaBtc)) return 0;
  const held = qty !== 0 && avgEntry > 0 ? (qty * cs) / avgEntry : 0; // текущая долларовая дельта
  if (qty === 0 || held === 0 || Math.sign(deltaBtc) === Math.sign(qty)) return (deltaBtc * priceRef) / cs;
  if (Math.abs(deltaBtc) <= Math.abs(held)) return (deltaBtc * avgEntry) / cs; // уменьшение
  return -qty + ((held + deltaBtc) * priceRef) / cs; // переворот: закрыть всё, остаток по priceRef
}

// Apply a (paper) perp fill to perpState, inverse-contract aware. Converts the BTC order size to
// signed $10 contracts at priceRef, then either grows the position (weighted-average entry) or
// reduces/flips it (booking inverse realized USD = closedSigned·cs·(priceRef−avgEntry)/avgEntry).
// Mutates perpState in place and returns this fill's summary.
//
// СРЕДНИЙ ВХОД ОБРАТНОГО КОНТРАКТА УСРЕДНЯЕТСЯ ПО 1/P, А НЕ ПО P, И ЭТО НЕ ОТТЕНОК. У обратного
// контракта и P&L, и дельта линейны по 1/вход, а не по входу:
//   upl_usd = Σ qᵢ·cs·(P − Pᵢ)/Pᵢ,   ∂upl_usd/∂P = Σ qᵢ·cs/Pᵢ.
// Значит средний вход обязан сохранять СУММУ qᵢ/Pᵢ, то есть быть средним гармоническим. Пока он
// складывался арифметически, обе величины считались НЕВЕРНО для позиции, набранной по разным ценам
// (совпадение получалось только когда все лоты по одной цене - ровно этот случай и покрывали тесты).
//
// АЛГЕБРА РАСХОЖДЕНИЯ, чтобы это не выглядело вкусовщиной. Для двух лотов равенство
//   (q₁+q₂)²·P₁P₂ = (q₁P₁+q₂P₂)(q₁P₂+q₂P₁)  сводится к  2P₁P₂ = P₁²+P₂²  ⟺  (P₁−P₂)² = 0,
// то есть арифметический вход точен ТОЛЬКО при равных ценах, а в остальных случаях занижает и
// дельту, и P&L. Замер (позиция 2115 контрактов по 47000 плюс 144 по 48000): дельта 0.4799873
// вместо 0.4800000, P&L при 52000 равен 2369.34 вместо 2370.00.
//
// ЧЕМ ЭТО ЛОВИЛОСЬ И ПОЧЕМУ ВАЖНО ХЕДЖУ. Дефект найден прогоном истории через живой движок
// (`scripts/replay-sellhedge.mjs`): движок НЕ ПОПАДАЛ В СОБСТВЕННУЮ ЦЕЛЬ хеджа. На ДОБАВЛЕНИИ сама
// заявка считалась верно (Δq = невязка·P/cs добавляет ровно невязку долларовой дельты), а уплывало
// ИЗМЕРЕНИЕ позиции после неё, и промах КОПИЛСЯ: 1.3e-5 BTC после одной перекладки на движении 2%,
// 4.4e-4 после десяти. Вторая половина того же промаха жила в пересчёте заявки на УМЕНЬШЕНИИ - см.
// contractsForDelta выше. Хедж, который мажет мимо своей цели, возвращает направленную ставку -
// ровно ту, ради снятия которой он и заводится.
export function applyFill(perpState, hedge_order, priceRef, meta, cfg) {
  const cs = meta.contractSize;
  const signedBtc = (hedge_order.side === "buy" ? 1 : -1) * hedge_order.amount_rounded_btc;
  // Дельта в BTC переводится в целые контракты по $10. Пересчёт зависит от того, добавляем мы лот или закрываем
  // старые контракты со своим базисом (см. contractsForDelta): «по текущей цене» верно лишь для
  // добавления. Округление до целого контракта и есть настоящая гранулярность биржи.
  const contractsDelta = Math.round(contractsForDelta(perpState, signedBtc, priceRef, cs));

  const qty = perpState.qty;
  let realized = 0;
  if (qty === 0 || Math.sign(contractsDelta) === Math.sign(qty)) {
    // opening or adding in the same direction: blend the entry on 1/P (see header).
    // Открытие с нуля (qty 0, avgEntry 0) даёт 0/0, поэтому держимая часть учитывается только когда
    // она есть И оценена: иначе весь размер считается вошедшим по priceRef, что для входа и верно.
    const absQty = Math.abs(qty) > 0 && perpState.avgEntry > 0 ? Math.abs(qty) : 0;
    const absAdd = Math.abs(contractsDelta);
    const denom = absQty + absAdd;
    if (denom > 0) {
      perpState.avgEntry = denom / (absQty > 0 ? absQty / perpState.avgEntry + absAdd / priceRef : absAdd / priceRef);
    }
  } else {
    // reducing or flipping - realize P&L on the closed contracts (inverse: USD per contract)
    const closing = Math.min(Math.abs(contractsDelta), Math.abs(qty));
    const closedSigned = Math.sign(qty) * closing;
    realized = (closedSigned * cs * (priceRef - perpState.avgEntry)) / perpState.avgEntry;
    if (Math.abs(contractsDelta) > Math.abs(qty)) perpState.avgEntry = priceRef; // flipped through 0
  }

  perpState.qty += contractsDelta;
  if (perpState.qty === 0) perpState.avgEntry = 0;
  perpState.realizedUsd = (perpState.realizedUsd || 0) + realized;
  // Fee rate follows the ORDER's execution style (not cfg.execStyle): flatten orders are always
  // order_type "market" (taker) even when the structure hedges with post-only limits. Сама ставка
  // берётся из снимка перпа (мета биржи), cfg лишь запасное значение - см. perpFeeRate.
  const feeRate = perpFeeRate(meta, cfg, hedge_order.order_type);
  const feeUsd = Math.abs(contractsDelta) * cs * feeRate;
  perpState.feesCum = (perpState.feesCum || 0) + feeUsd;

  return { filledContracts: contractsDelta, priceRef, feeUsd, realizedUsd: realized };
}
